import { timingSafeEqual } from "crypto";
import { after, NextResponse } from "next/server";
import { Prisma } from "~/generated/prisma/client";
import { z } from "zod";
import { env } from "~/env";
import { db } from "~/server/clients/db";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";
import { computeNextRunSafe } from "~/server/api/routers/nimits-jarvis/agent/tools/cron-utils";
import { stripToolResultEchoes } from "~/server/api/routers/nimits-jarvis/agent/strip-tool-echoes";
import { toHuman, toModel } from "~/server/api/routers/nimits-jarvis/agent/pii/brands";
import { rateLimit } from "~/server/clients/rate-limit";
import { sendTelegramMessage } from "~/server/clients/telegram";
import { executeJobInput, cronJobRow, type CronJobRow } from "./route.schema";

async function loadJobsFromDb(jobIds: string[]) {
  const rows = z.array(cronJobRow).parse(
    await db.$queryRaw`
      SELECT
        cj.id,
        cj."instanceId",
        cj."chatId",
        ci."userId",
        cj.expression,
        cj.prompt,
        cj.timezone,
        cj."lockedBy",
        ci."telegramChatId"
      FROM composio_claw_cron_job cj
      JOIN composio_claw_instance ci ON cj."instanceId" = ci.id
      WHERE cj.id IN (${Prisma.join(jobIds)})
    `,
  );

  return rows;
}

async function releaseJobLocks(
  jobs: CronJobRow[],
  invocationId: string,
  now: Date,
  error?: string,
  retryDelaySeconds?: number,
) {
  const isRetry = typeof retryDelaySeconds === "number" && retryDelaySeconds > 0;
  const values = jobs.map((job) => {
    let nextRunAt: Date | null = null;
    if (isRetry) {
      nextRunAt = new Date(now.getTime() + retryDelaySeconds * 1000);
    } else {
      nextRunAt = computeNextRunSafe(job.expression, job.timezone);
    }
    return nextRunAt
      ? Prisma.sql`(${job.id}, ${nextRunAt}::timestamptz)`
      : Prisma.sql`(${job.id}, NULL::timestamptz)`;
  });

  await db.$queryRaw`
    UPDATE composio_claw_cron_job AS cj
    SET
      "lastRunAt" = CASE WHEN ${error ?? null}::text IS NULL AND NOT ${isRetry} THEN ${now}::timestamptz ELSE cj."lastRunAt" END,
      "nextRunAt" = v."nextRunAt"::timestamptz,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "lastError" = ${error ?? null}
    FROM (VALUES ${Prisma.join(values)}) AS v(id, "nextRunAt")
    WHERE cj.id = v.id
      AND cj."lockedBy" = ${invocationId}
  `;
}

async function executeJobs(
  jobs: CronJobRow[],
  invocationId: string,
  nowOverride?: string,
) {
  const now = nowOverride ? new Date(nowOverride) : new Date();

  try {
    const allowedJobs: CronJobRow[] = [];
    const limitedJobs: CronJobRow[] = [];
    let maxRetryAfterSeconds = 60;

    for (const job of jobs) {
      const limit = await rateLimit(job.userId, "cron");
      if (limit.allowed) {
        allowedJobs.push(job);
      } else {
        limitedJobs.push(job);
        if (limit.retryAfterSeconds && limit.retryAfterSeconds > maxRetryAfterSeconds) {
          maxRetryAfterSeconds = limit.retryAfterSeconds;
        }
        console.warn(
          `[cron/execute] rate limit exceeded for user ${job.userId}; job_id=${job.id}; retry_after=${limit.retryAfterSeconds}s`,
        );
      }
    }

    if (limitedJobs.length > 0) {
      await releaseJobLocks(
        limitedJobs,
        invocationId,
        now,
        "Rate limit exceeded (queued for retry)",
        maxRetryAfterSeconds,
      );
    }

    if (allowedJobs.length === 0) {
      return;
    }

    const instanceId = allowedJobs[0]!.instanceId;
    const telegramChatId = allowedJobs[0]!.telegramChatId;

    let chatId = allowedJobs[0]!.chatId;
    if (!chatId) {
      // Fallback: use first chat for this instance
      const firstChat = await db.chat.findFirst({
        where: { instanceId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!firstChat) {
        console.error(`[cron/execute] No chat found for instance ${instanceId}; job IDs: ${allowedJobs.map(j => j.id).join(", ")}`);
        await releaseJobLocks(allowedJobs, invocationId, now, "No chat found for instance");
        return;
      }
      chatId = firstChat.id;
    }

    // Combine all prompts into a single user message
    const combinedMessage = allowedJobs
      .map((j) => `<scheduled-task>\n${j.prompt}\n</scheduled-task>`)
      .join("\n\n");

    const prepareResult = await prepareAgentRun({
      instanceId,
      chatId,
      userMessage: combinedMessage,
      source: "cron",
      userMessageType: "hidden",
    });

    const { agent, messages, piiVault } = prepareResult.result;

    const result = await agent.generate({ prompt: messages });

    // Release all job locks in a single query (each gets its own nextRunAt)
    await releaseJobLocks(allowedJobs, invocationId, now);

    // Forward to Telegram if linked
    if (telegramChatId) {
      const rawText = stripToolResultEchoes(result.text);
      const cleanedText = piiVault
        ? toHuman(piiVault, toModel(rawText))
        : rawText;
      if (cleanedText) {
        const truncated =
          cleanedText.length > 4096
            ? cleanedText.slice(0, 4093) + "..."
            : cleanedText;
        try {
          await sendTelegramMessage(telegramChatId, truncated);
        } catch (error) {
          console.error("[cron/execute] telegram delivery failed:", error);
        }
      }
    }
  } catch (error) {
    console.error("[cron/execute] job execution failed:", error);

    try {
      await releaseJobLocks(
        jobs,
        invocationId,
        now,
        "Scheduled task execution failed",
      );
    } catch (releaseError) {
      console.error("[cron/execute] lock release failed:", releaseError);
    }
  }
}

export const maxDuration = 300;

export async function POST(request: Request) {
  // Bearer-auth via CRON_SECRET (auto-injected by Vercel for cron-triggered
  // routes; the dispatcher /api/cron/nimits-jarvis forwards it on internal fetch).
  // Dev mode allows unauthenticated calls so the local trigger script works.
  if (env.NODE_ENV !== "development") {
    // Fail closed before the bearer comparison: if CRON_SECRET is missing
    // (e.g. env validation was bypassed and the var was never set), the
    // expected header would interpolate to `Bearer undefined` and accept
    // anyone sending that literal string. Reject the request outright.
    if (typeof env.CRON_SECRET !== "string" || env.CRON_SECRET.length === 0) {
      return new Response("Server misconfigured: CRON_SECRET missing", {
        status: 503,
      });
    }
    const auth = request.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
    const actual = Buffer.from(auth);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const body: unknown = await request.json();
  const parsed = executeJobInput.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { jobIds, invocationId, nowOverride } = parsed.data;

  const jobs = await loadJobsFromDb(jobIds);

  if (jobs.length === 0) {
    return NextResponse.json({ error: "No jobs found" }, { status: 404 });
  }

  // Filter to jobs with valid fencing tokens
  const validJobs = jobs.filter((job) => job.lockedBy === invocationId);

  if (validJobs.length === 0) {
    return NextResponse.json(
      { error: "Fencing token mismatch for all jobs" },
      { status: 403 },
    );
  }

  after(executeJobs(validJobs, invocationId, nowOverride));

  return NextResponse.json(
    { status: "accepted", jobCount: validJobs.length },
    { status: 202 },
  );
}
