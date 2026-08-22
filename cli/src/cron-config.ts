import { exec as _exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { spinner, log } from "@clack/prompts";

const exec = promisify(_exec);

// Unbounded: all plans run with Pro-level ceilings — cron every minute, max execution.
const HOBBY_SCHEDULE = "* * * * *";
const PRO_SCHEDULE = "* * * * *";

// No Hobby cap — always allow long runs (up to 300s, Vercel Pro/Fluid limit).
const HOBBY_MAX_DURATION = 300;
const PRO_MAX_DURATION = 300;

// tRPC buffer under function timeout.
const HOBBY_TRPC_MAX_DURATION_MS = 270_000;
const PRO_TRPC_MAX_DURATION_MS = 270_000;

const ROUTE_FILES_WITH_MAX_DURATION = [
  "src/app/api/chat/route.ts",
  "src/app/api/cron/nimits-jarvis/execute/route.ts",
  "src/app/api/telegram-webhook/route.ts",
  "src/app/api/trpc/[trpc]/route.ts",
];

const TRPC_CONFIG_FILE = "src/server/api/trpc.ts";

interface VercelJson {
  crons?: Array<{ path: string; schedule: string }>;
  [key: string]: unknown;
}

async function rewriteCronSchedule(rootDir: string, schedule: string): Promise<boolean> {
  const vercelJsonPath = join(rootDir, "vercel.json");
  let raw: string;
  try {
    raw = await readFile(vercelJsonPath, "utf-8");
  } catch {
    return false;
  }
  const data = JSON.parse(raw) as VercelJson;
  if (!data.crons || data.crons.length === 0) return false;
  if (data.crons.every((c) => c.schedule === schedule)) return false;

  data.crons = data.crons.map((c) => ({ ...c, schedule }));
  await writeFile(vercelJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return true;
}

async function rewriteMaxDuration(rootDir: string, value: number): Promise<boolean> {
  let anyChanged = false;
  const re = /export const maxDuration = \d+;/;
  for (const rel of ROUTE_FILES_WITH_MAX_DURATION) {
    const path = join(rootDir, rel);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const next = raw.replace(re, `export const maxDuration = ${value};`);
    if (next !== raw) {
      await writeFile(path, next, "utf-8");
      anyChanged = true;
    }
  }
  return anyChanged;
}

async function rewriteTrpcMaxDurationMs(
  rootDir: string,
  valueMs: number,
): Promise<boolean> {
  const path = join(rootDir, TRPC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return false;
  }
  const re = /maxDurationMs:\s*[\d_]+/;
  // Format with underscores for readability (50_000 / 270_000).
  const formatted = valueMs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  const next = raw.replace(re, `maxDurationMs: ${formatted}`);
  if (next === raw) return false;
  await writeFile(path, next, "utf-8");
  return true;
}

/**
 * Adjust plan-sensitive config (cron schedule + serverless function maxDuration)
 * to fit the user's Vercel plan, then commit so it lands in the pushed copy.
 * No-op when nothing actually needs to change.
 */
export async function applyPlanConfig(rootDir: string, plan: string): Promise<void> {
  const isHobby = plan === "hobby";
  const schedule = isHobby ? HOBBY_SCHEDULE : PRO_SCHEDULE;
  const maxDuration = isHobby ? HOBBY_MAX_DURATION : PRO_MAX_DURATION;
  const trpcMaxDurationMs = isHobby
    ? HOBBY_TRPC_MAX_DURATION_MS
    : PRO_TRPC_MAX_DURATION_MS;

  const s = spinner();
  s.start(`Tuning config for ${plan} plan`);

  const cronChanged = await rewriteCronSchedule(rootDir, schedule);
  const durationChanged = await rewriteMaxDuration(rootDir, maxDuration);
  const trpcChanged = await rewriteTrpcMaxDurationMs(rootDir, trpcMaxDurationMs);

  if (!cronChanged && !durationChanged && !trpcChanged) {
    s.stop(`Config already matches ${plan} plan`);
    return;
  }

  await exec("git add vercel.json src/app/api src/server/api/trpc.ts", {
    cwd: rootDir,
  });
  const { stdout: staged } = await exec("git diff --cached --name-only", {
    cwd: rootDir,
  });
  if (!staged.trim()) {
    s.stop("Nothing to commit");
    return;
  }

  try {
    await exec(
      `git commit -m "chore: tune config for ${plan} plan (cron + maxDuration)"`,
      { cwd: rootDir },
    );
    s.stop(`Committed config for ${plan} plan`);
  } catch (err) {
    s.stop("Failed to commit config");
    log.warn(
      "Make sure git user.name and user.email are configured globally. " +
        "Run: git config --global user.name '...' && git config --global user.email '...'",
    );
    throw err;
  }
}

