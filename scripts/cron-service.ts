import "dotenv/config";
import { Command } from "commander";
import { execFileSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "~/server/clients/db";

const require = createRequire(import.meta.url);

const SERVICE_LABEL = "com.nimits.jarvis.cron";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs", "nimits-jarvis");
const STDOUT_LOG = join(LOG_DIR, "cron.out.log");
const STDERR_LOG = join(LOG_DIR, "cron.err.log");

function nodeExecutable(): string {
  return process.execPath;
}

function resolveTsxCli(): string {
  const pkgPath = require.resolve("tsx");
  return pkgPath.replace(/\/dist\/.*$/, "/dist/cli.mjs");
}

function generatePlist(): string {
  const nodePath = nodeExecutable();
  const tsxCli = resolveTsxCli();
  const daemonScript = join(PROJECT_ROOT, "scripts", "cron-daemon.ts");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${tsxCli}</string>
    <string>${daemonScript}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>development</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function isServiceRunning(): boolean {
  try {
    const out = execFileSync("/bin/launchctl", ["list"], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .some((line) => line.includes(SERVICE_LABEL) && !line.startsWith("-"));
  } catch {
    return false;
  }
}

function loadService(): void {
  execFileSync("/bin/launchctl", ["load", PLIST_PATH], { stdio: "inherit" });
}

function unloadService(): void {
  try {
    execFileSync("/bin/launchctl", ["unload", PLIST_PATH], { stdio: "inherit" });
  } catch {
    // Already unloaded — ignore.
  }
}

function getServicePid(): number | null {
  try {
    const out = execFileSync(
      "/bin/launchctl",
      ["list", SERVICE_LABEL],
      { encoding: "utf8" },
    );
    const match = out.match(/"PID"\s*=\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function listCronJobs(): void {
  db.cronJob
    .findMany({
      orderBy: { nextRunAt: "asc" },
      select: {
        id: true,
        enabled: true,
        expression: true,
        timezone: true,
        nextRunAt: true,
        lastRunAt: true,
        lockedBy: true,
        lastError: true,
        instance: { select: { name: true } },
      },
    })
    .then((jobs) => {
      for (const job of jobs) {
        const state = job.lockedBy
          ? "RUNNING"
          : job.lastError
            ? "ERRORED"
            : "SCHEDULED";
        console.log(
          `[${state}] ${job.id} | ${job.enabled ? "on" : "off"} | "${job.expression}" (${job.timezone}) | next=${job.nextRunAt?.toISOString() ?? "n/a"} | last=${job.lastRunAt?.toISOString() ?? "n/a"} | instance=${job.instance?.name ?? "?"}`,
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Failed to list cron jobs:", err);
      process.exit(1);
    });
}

const program = new Command();
program
  .name("cron-service")
  .description("Manage the local Nimits-Jarvis cron daemon via launchd")
  .version("0.1.0");

program
  .command("install")
  .description("Install and start the launchd cron daemon service")
  .action(() => {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(PLIST_PATH, generatePlist());
    console.log(`[install] Wrote ${PLIST_PATH}`);
    loadService();
    const pid = getServicePid();
    console.log(
      pid
        ? `[install] Service running (pid=${pid})`
        : "[install] Service loaded (status: starting)",
    );
  });

program
  .command("uninstall")
  .description("Stop and remove the launchd cron daemon service")
  .action(() => {
    unloadService();
    if (existsSync(PLIST_PATH)) {
      rmSync(PLIST_PATH);
      console.log(`[uninstall] Removed ${PLIST_PATH}`);
    } else {
      console.log("[uninstall] No plist found — nothing to remove");
    }
  });

program
  .command("status")
  .description("Show the daemon service status")
  .action(() => {
    const pid = getServicePid();
    if (pid) {
      console.log(`[status] ${SERVICE_LABEL} is RUNNING (pid=${pid})`);
    } else {
      console.log(`[status] ${SERVICE_LABEL} is NOT running`);
    }
    console.log(`[status] plist: ${PLIST_PATH}`);
    console.log(`[status] stdout: ${STDOUT_LOG}`);
    console.log(`[status] stderr: ${STDERR_LOG}`);
  });

program
  .command("restart")
  .description("Restart the daemon service")
  .action(() => {
    unloadService();
    if (existsSync(PLIST_PATH)) {
      loadService();
      const pid = getServicePid();
      console.log(pid ? `[restart] Running (pid=${pid})` : "[restart] Loaded");
    } else {
      console.error("[restart] No plist installed. Run `cron-service install` first.");
      process.exit(1);
    }
  });

program
  .command("trigger")
  .description("Run a single tick now (same as --once)")
  .action(() => {
    execFile(
      process.execPath,
      [resolveTsxCli(), join(PROJECT_ROOT, "scripts", "cron-daemon.ts"), "--once"],
      { cwd: PROJECT_ROOT, env: process.env },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (error) process.exit(error.code ?? 1);
      },
    );
  });

program
  .command("logs")
  .description("Tail the daemon log files")
  .option("-f, --follow", "keep following the logs")
  .action((opts: { follow?: boolean }) => {
    if (!existsSync(STDOUT_LOG) && !existsSync(STDERR_LOG)) {
      console.log("[logs] No log files yet.");
      return;
    }
    const cmd = opts.follow ? "tail -f" : "tail -n 50";
    const files = [STDOUT_LOG, STDERR_LOG].filter((f) => existsSync(f)).join(" ");
    execFileSync("/bin/sh", ["-c", `${cmd} ${files}`], { stdio: "inherit" });
  });

program
  .command("list")
  .description("List all cron jobs with their status")
  .action(listCronJobs);

program.parseAsync();