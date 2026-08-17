import "dotenv/config";
import { Prisma } from "~/generated/prisma/client";
import { z } from "zod";
import { db } from "~/server/clients/db";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";
import { computeNextRunSafe } from "~/server/api/routers/nimits-jarvis/agent/tools/cron-utils";
import { stripToolResultEchoes } from "~/server/api/routers/nimits-jarvis/agent/strip-tool-echoes";
import { toHuman, toModel } from "~/server/api/routers/nimits-jarvis/agent/pii/brands";
import { rateLimit } from "~/server/clients/rate-limit";
import { sendTelegramMessage } from "~/server/clients/telegram";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TICK_INTERVAL_MS = 10_000; // poll every 10s for minute-granular cron precision

const claimedJobRow = z.object({
  id: z.string(),
  instanceId: z.string(),
  chatId: z.string().nullable(),
});

const staleJobRow = z.object({
  id: z.string(),
  expression: z.string(),
  timezone: z.string(),
});

const cronJobRow = z.object({
  id: z.string(),
  instanceId: z.string(),
  chatId: z.string().nullable(),
  userId: z.string(),
  expression: z.string(),
  prompt: z.string(),
  timezone: z.string(),
  lockedBy: z.string().nullable(),
  telegramChatId: z.string().nullable(),
});

type CronJobRow = z.infer<typeof cronJobRow>;

async function loadJobsFromDb(jobIds: string[]): Promise<CronJobRow[]> {
  if (jobIds.length === 0) return [];
  return z.array(cronJobRow).parse(
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
}

async function releaseJobLocks(
  jobs: CronJobRow[],
  invocationId: string,
  now: Date,
  error?: string,
): Promise<void> {
  if (jobs.length === 0) return;
  const values = jobs.map((job) => {
    const nextRunAt = computeNextRunSafe(job.expression, job.timezone);
    return nextRunAt
      ? Prisma.sql`(${job.id}, ${nextRunAt}::timestamptz)`
      : Prisma.sql`(${job.id}, NULL::timestamptz)`;
  });

  await db.$queryRaw`
    UPDATE composio_claw_cron_job AS cj
    SET
      "lastRunAt" = CASE WHEN ${error ?? null}::text IS NULL THEN ${now}::timestamptz ELSE cj."lastRunAt" END,
      "nextRunAt" = v."nextRunAt"::timestamptz,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "lastError" = ${error ?? null}
    FROM (VALUES ${Prisma.join(values)}) AS v(id, "nextRunAt")
    WHERE cj.id = v.id
      AND cj."lockedBy" = ${invocationId}
  `;
}

async function executeJobBatch(
  jobs: CronJobRow[],
  invocationId: string,
  now: Date,
): Promise<void> {
  try {
    const allowedJobs: CronJobRow[] = [];
    const limitedJobs: CronJobRow[] = [];

    for (const job of jobs) {
      const limit = await rateLimit(job.userId, "cron");
      if (limit.allowed) {
        allowedJobs.push(job);
      } else {
        limitedJobs.push(job);
        console.warn(
          `[daemon/execute] Rate limit exceeded for user ${job.userId}; job_id=${job.id}`,
        );
      }
    }

    if (limitedJobs.length > 0) {
      await releaseJobLocks(limitedJobs, invocationId, now);
    }

    if (allowedJobs.length === 0) {
      return;
    }

    const instanceId = allowedJobs[0]!.instanceId;
    const telegramChatId = allowedJobs[0]!.telegramChatId;

    let chatId = allowedJobs[0]!.chatId;
    if (!chatId) {
      const firstChat = await db.chat.findFirst({
        where: { instanceId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!firstChat) {
        console.error(
          `[daemon/execute] No chat found for instance ${instanceId}; job IDs: ${allowedJobs.map((j) => j.id).join(", ")}`,
        );
        await releaseJobLocks(
          allowedJobs,
          invocationId,
          now,
          "No chat found for instance",
        );
        return;
      }
      chatId = firstChat.id;
    }

    const combinedMessage = allowedJobs
      .map((j) => `<scheduled-task>\n${j.prompt}\n</scheduled-task>`)
      .join("\n\n");

    console.log(
      `[daemon/execute] Running agent for instance=${instanceId}, chat=${chatId}, jobs=${allowedJobs.map((j) => j.id).join(", ")}`,
    );

    const prepareResult = await prepareAgentRun({
      instanceId,
      chatId,
      userMessage: combinedMessage,
      source: "cron",
      userMessageType: "hidden",
    });

    const { agent, messages, piiVault } = prepareResult.result;
    const result = await agent.generate({ prompt: messages });

    await releaseJobLocks(allowedJobs, invocationId, now);
    console.log(
      `[daemon/execute] Finished batch successfully: ${allowedJobs.map((j) => j.id).join(", ")}`,
    );

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
          console.log(
            `[daemon/execute] Telegram notification sent to ${telegramChatId}`,
          );
        } catch (error) {
          console.error("[daemon/execute] Telegram delivery failed:", error);
        }
      }
    }
  } catch (error) {
    console.error("[daemon/execute] Execution error:", error);
    try {
      await releaseJobLocks(
        jobs,
        invocationId,
        now,
        error instanceof Error
          ? error.message
          : "Scheduled task execution failed",
      );
    } catch (releaseError) {
      console.error("[daemon/execute] Lock release error:", releaseError);
    }
  }
}

export async function runCronTick(): Promise<number> {
  const now = new Date();
  const invocationId = crypto.randomUUID();
  const lockTimeout = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  const claimedJobs = z.array(claimedJobRow).parse(
    await db.$queryRaw`
      UPDATE composio_claw_cron_job cj
      SET
        "lockedAt" = ${now},
        "lockedBy" = ${invocationId},
        "nextRunAt" = NULL
      FROM composio_claw_instance ci
      WHERE cj."instanceId" = ci.id
        AND cj.enabled = true
        AND (
          (cj."nextRunAt" <= ${now} AND cj."lockedAt" IS NULL)
          OR (cj."lockedAt" IS NOT NULL AND cj."lockedAt" < ${lockTimeout})
        )
      RETURNING cj.id, cj."instanceId", cj."chatId"
    `,
  );

  const staleJobs = z.array(staleJobRow).parse(
    await db.$queryRaw`
      SELECT id, expression, timezone
      FROM composio_claw_cron_job
      WHERE "nextRunAt" <= ${now}
        AND "lockedAt" IS NULL
        AND enabled = false
    `,
  );

  if (staleJobs.length > 0) {
    const values = staleJobs
      .map((job) => {
        const nextRunAt = computeNextRunSafe(job.expression, job.timezone);
        return nextRunAt
          ? Prisma.sql`(${job.id}, ${nextRunAt}::timestamptz)`
          : null;
      })
      .filter((v): v is Prisma.Sql => v !== null);

    if (values.length > 0) {
      await db.$queryRaw`
        UPDATE composio_claw_cron_job AS cj
        SET "nextRunAt" = v."nextRunAt"::timestamptz
        FROM (VALUES ${Prisma.join(values)}) AS v(id, "nextRunAt")
        WHERE cj.id = v.id
      `;
    }
  }

  if (claimedJobs.length === 0) {
    return 0;
  }

  console.log(
    `[daemon/tick] Claimed ${claimedJobs.length} job(s) at ${now.toISOString()}`,
  );

  const jobsByChat = new Map<string, string[]>();
  for (const job of claimedJobs) {
    const key = `${job.instanceId}:${job.chatId ?? "default"}`;
    const existing = jobsByChat.get(key);
    if (existing) {
      existing.push(job.id);
    } else {
      jobsByChat.set(key, [job.id]);
    }
  }

  const jobIdsList = claimedJobs.map((j) => j.id);
  const loadedJobs = await loadJobsFromDb(jobIdsList);

  for (const [, jobIds] of jobsByChat.entries()) {
    const batchJobs = loadedJobs.filter((j) => jobIds.includes(j.id));
    if (batchJobs.length > 0) {
      await executeJobBatch(batchJobs, invocationId, now);
    }
  }

  return claimedJobs.length;
}

async function main(): Promise<void> {
  const isOnceMode = process.argv.includes("--once");
  console.log(
    `[daemon] Nimits-Jarvis Local Cron Daemon (pid=${process.pid}, mode=${isOnceMode ? "once" : "continuous"})`,
  );

  if (isOnceMode) {
    const ran = await runCronTick();
    console.log(`[daemon] Single tick finished. Executed ${ran} job(s).`);
    process.exit(0);
  }

  let running = true;
  const shutdown = () => {
    console.log("[daemon] Shutting down gracefully...");
    running = false;
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      await runCronTick();
    } catch (err) {
      console.error("[daemon] Tick error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[daemon] Fatal error:", err);
    process.exit(1);
  });
}
