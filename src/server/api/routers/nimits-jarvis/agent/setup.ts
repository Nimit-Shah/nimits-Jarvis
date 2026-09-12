import { ToolLoopAgent, stepCountIs } from "ai";
import type { ToolSet, SystemModelMessage } from "ai";
import { after } from "next/server";
import { db } from "~/server/clients/db";
import { getOrCreateSessionAndTools } from "~/server/clients/composio";
import { decrypt } from "~/lib/crypto";
import { buildSystemPrompt, buildVolatileModeLines } from "./system-prompt";
import { isPlaceholderChatName, deriveChatName } from "./chat-name";
import { DEFAULT_TIMEZONE } from "~/lib/timezone";
import { ollamaProvider } from "~/server/clients/ollama";
import {
  createCustomTools,
  searchMemoriesForContext,
  shouldLookupMemoriesForContext,
} from "./tools";
import { getContextWindow } from "./context/context-window";
import { pruneContext } from "./context/context-pruning";
import { estimateSectionTokens } from "./token-metrics";
import {
  loadContextMessages,
  buildContext,
  toPlainRecordSafe,
  toPrismaJson,
  runPostResponseTasks,
  sanitizeString,
  deepSanitize,
} from "./context/build-context";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./context/token-estimation";
import type { SectionTokens } from "./token-metrics";

// ---------------------------------------------------------------------------
// Helpers for collapsed reasoning/tool summary (Claude.ai-inspired)
// ---------------------------------------------------------------------------
function formatToolDisplayName(raw: string): string {
  let d = raw;
  for (const p of ["COMPOSIO_", "RUBE_"])
    if (d.startsWith(p)) {
      d = d.slice(p.length);
      break;
    }
  return d
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
function extractReasoningGloss(text: string): string | undefined {
  const m = text.match(/^\s*SUMMARY:\s*(.+)$/m);
  if (m?.[1]) return m[1].trim().slice(0, 80);
  const first = text.split(/[.!\n]/)[0]?.trim() ?? "";
  if (!first) return undefined;
  const words = first.split(/\s+/).slice(0, 10).join(" ");
  return words.length > 3 ? words : undefined;
}
import { stripToolResultEchoes } from "./strip-tool-echoes";
import {
  clearStreamingMessage,
  persistVaultSnapshot,
  releaseChatRun,
} from "~/server/clients/redis";
import { releaseRun } from "~/server/lib/run-registry";
import { MAX_AUTO_WRITES_PER_MESSAGE } from "~/server/lib/fs-access/write-paths";
import type { ReconstructedMessage, FsAccessMode } from "./types";
import { getModelProvider, isAnthropicModel, buildLLM } from "./model-utils";
import { optimizeToolSchemas } from "./tool-optimizer";
import { applySkillToolCap } from "~/server/lib/skills/cap";
import {
  formatPinnedSkillBlock,
} from "~/server/lib/skills/materialize";
import { resolvePinnedSkills } from "~/server/lib/skills/pins";
import { resolveConsentedSkills } from "~/server/lib/skills/consent";
import {
  extractSkillStateUpdates,
  saveSkillState,
} from "~/server/lib/skills/state";
import { splitSkillTools } from "./tools/load-skill";
import {
  PIIVault,
  PIITransportShield,
  stripResidualTokens,
  deepStripResidualTokens,
} from "./pii";

type MessageSource = "web" | "telegram" | "cron";

export type { FsAccessMode };

/**
 * The clamp is the security boundary. The requested mode comes from the client
 * (never trusted); telegram/cron are unattended (no human to confirm) and are
 * therefore always read-only regardless of what was requested.
 */
export function resolveFsMode(
  requested: FsAccessMode | undefined,
  source: MessageSource,
  instance: { fsWriteAllowed: boolean },
): FsAccessMode {
  if (source !== "web") return "read-only";
  if (requested === "full" && instance.fsWriteAllowed) return "full";
  return "read-only";
}

/**
 * Wraps every tool's execute function to:
 * 1. Sanitize return values (replace lone Unicode surrogates with U+FFFD).
 * 2. Optionally redact PII in tool results when a PIIVault is active.
 *
 * Composio tool results (e.g. scraped web pages, email bodies) can contain
 * malformed Unicode that produces invalid JSON, and PII that should not
 * reach external LLMs.
 */
interface WrapToolOptions {
  /**
   * Tools whose ARGUMENTS must NOT have PII tokens restored. Phase B: fs_write
   * and fs_edit receive content — a model emitting [CLAW_EMAIL_A1B2] inside
   * newText would have the real address substituted and written to disk in
   * plaintext. Every existing PII layer guards data flowing TO the model; this
   * guards data flowing TO DISK. The diff shown to the operator can still
   * display real values (presentation layer only).
   */
  noArgumentRestore?: Set<string>;
  /**
   * Tools whose results are pure filesystem structure (paths, names, sizes).
   * Results skip PII scanning/redaction entirely and return as-is — no tokens
   * are registered and no text is rewritten. Coherent with local file access:
   * file/folder NAMES reach the model unredacted by explicit product decision.
   * fs_read CONTENT is NOT exempt — see piiScanFieldsByTool.
   */
  piiStructuralTools?: Set<string>;
  /**
   * Per-tool field-scoped PII scanning. Only the listed top-level fields are
   * scanned and redacted (e.g. fs_read's `content` — a file can contain real
   * emails); every other field passes through untouched. Keeps layer-2 redaction
   * covering the half of fs output that can hold real PII while skipping
   * structural noise (line counts, byte sizes) that would seed false positives.
   */
  piiScanFieldsByTool?: Record<string, string[]>;
}

function wrapToolExecutors(
  tools: ToolSet,
  vault: PIIVault | null,
  restoreCache: Map<string, unknown>,
  options?: WrapToolOptions,
): ToolSet {
  const noRestore = options?.noArgumentRestore ?? new Set<string>();
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }
    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: Parameters<typeof originalExecute>) => {
        // Step 1: Restore PII tokens in tool inputs before sending
        // to Composio. The LLM generated tool args may contain PII tokens
        // like [CLAW_EMAIL_A1B2] that need to be restored to real values.
        // After restore, deep-strip any residual (orphan) token the vault
        // could not resolve — otherwise it would be persisted verbatim by
        // durable tools (memory_save, Mnemosyne) and re-leak forever.
        // EXCEPT for write tools (noArgumentRestore): the token must reach
        // disk as the token, never the real value.
        const [input] = args;
        // The AI SDK passes a toolCallId inside the execution options (args[1]).
        const execOptions = args[1] as { toolCallId?: string } | undefined;
        const tid = execOptions?.toolCallId;
        const restoredInput = noRestore.has(name)
          ? input
          : deepStripResidualTokens(
              // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
              vault ? vault.restoreDeep(input) : input,
            );
        // Cache the restored (real) input ONCE so DB persistence + any UI
        // re-render reads the exact same value the third-party tool saw.
        if (vault && tid) {
          restoreCache.set(tid, restoredInput);
        }

        // Step 2: Call the actual tool with restored (real) values
        let result;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          result = await originalExecute(
            restoredInput,
            ...(args.slice(1) as [any]),
          );
        } catch (error) {
          // Step 3: Sanitize error messages — any PII that leaked into
          // the error message (e.g. "Failed to send to john@example.com")
          // must be re-redacted before it reaches the LLM context.
          if (vault && error instanceof Error) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            error.message = await vault.redact(error.message);
          }
          throw error;
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const sanitized = deepSanitize(result);

        if (vault) {
          // Structural tools (fs_list, fs_find, ...): pure filesystem metadata —
          // no scanning, no redaction. Names/sizes pass through as-is.
          if (options?.piiStructuralTools?.has(name)) {
            if (tid) {
              restoreCache.set(`out:${tid}`, sanitized);
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return sanitized;
          }

          // Field-scoped scan (fs_read): scan and redact ONLY the listed
          // top-level fields (e.g. `content`), splice back into the untouched
          // result. Everything else (path, sizes) passes through unredacted.
          const scanFields = options?.piiScanFieldsByTool?.[name];
          if (scanFields && scanFields.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const scoped = { ...(sanitized as Record<string, unknown>) };
            for (const field of scanFields) {
              const value = scoped[field];
              if (typeof value === "string" && value.length > 0) {
                vault.registerStructuredPII({ [field]: value });
                scoped[field] = await vault.redact(value);
              }
            }
            if (tid) {
              restoreCache.set(`out:${tid}`, sanitized);
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return scoped;
          }

          // Default: extract structured PII from known fields (names, emails
          // in JSON) then redact all string values.
          vault.registerStructuredPII(sanitized);
          // Cache the REAL (pre-redaction) result once, keyed by tool call id,
          // so DB persistence reads the same value instead of re-restoring the
          // redacted copy.
          if (tid) {
            restoreCache.set(`out:${tid}`, sanitized);
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return await vault.redactToolResult(sanitized);
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return sanitized;
      },
    };
  }
  return wrapped;
}

/**
 * Redacts a list of reconstructed messages before they are sent to the LLM.
 * Returns a new deep-cloned array with text contents redacted.
 */
async function redactContextMessages(
  messages: ReconstructedMessage[],
  vault: PIIVault,
): Promise<ReconstructedMessage[]> {
  const result: ReconstructedMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ ...msg, content: await vault.redact(msg.content) });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ ...msg, content: await vault.redact(msg.content) });
      } else {
        const redactedParts = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            redactedParts.push({
              ...part,
              text: await vault.redact(part.text),
            });
          } else if (part.type === "tool-call") {
            redactedParts.push({
              ...part,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              input: (await vault.redactToolResult(part.input)) as Record<
                string,
                unknown
              >,
            });
          } else if (part.type === "reasoning") {
            const gloss = (part as unknown as { gloss?: string }).gloss;
            redactedParts.push({
              ...part,
              text: await vault.redact(part.text as string),
              ...(gloss !== undefined
                ? { gloss: await vault.redact(gloss) }
                : {}),
            } as typeof part);
          } else {
            redactedParts.push(part);
          }
        }
        result.push({ ...msg, content: redactedParts });
      }
    } else if (msg.role === "tool") {
      const redactedParts = [];
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          redactedParts.push({
            ...part,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            output: (await vault.redactToolResult(part.output)) as any,
          });
        } else {
          redactedParts.push(part);
        }
      }
      result.push({ ...msg, content: redactedParts });
    } else {
      result.push(msg);
    }
  }
  return result;
}

interface PrepareAgentRunParams {
  instanceId: string;
  chatId: string;
  userMessage: string;
  source: MessageSource;
  userMessageType?: "hidden";
  isVoice?: boolean;
  fsAccessMode?: FsAccessMode; // defaults to "read-only" via resolveFsMode when absent
  /**
   * Slugs pinned from the composer menu for this message. Validated against
   * the user's own Skill rows (unknown/unowned slugs dropped silently so a
   * stale client cannot probe). Per-message, never sticky. Ignored unless
   * source === "web" — cron/telegram cannot pin, so only trusted skills are
   * reachable there by construction.
   */
  pinnedSkills?: string[];
  /**
   * Web-chat run id (the SSE streamId). Passed so onFinish can release the
   * process-local run entry (heartbeat) and so callers can mark terminal
   * state on abort. Optional — telegram/cron runs don't have one.
   */
  streamId?: string;
}

interface PrepareAgentRunResult {
  agent: ToolLoopAgent;
  messages: ReconstructedMessage[];
  /** PII vault for this request. Null if redaction is disabled (local model). */
  piiVault: PIIVault | null;
  /** DB id of the pre-created assistant row (for abort/failure marking). */
  assistantMessageId: string;
  /**
   * Per-request timing + payload accounting (§0.1 instrumentation).
   * Shared mutable object: route.ts records ttftMs on the first SSE byte;
   * the agent's onFinish records genMs and persists/logs everything.
   */
  metrics: RequestMetrics;
}

interface RequestMetrics {
  sectionTokens: SectionTokens | null;
  ttftMs: number | null;
  genMs: number | null;
  startedAt: number;
}

type PrepareResult = { status: "ready"; result: PrepareAgentRunResult };

export async function prepareAgentRun(
  params: PrepareAgentRunParams,
): Promise<PrepareResult> {
  const {
    instanceId,
    chatId,
    userMessage,
    source,
    userMessageType,
    isVoice,
    fsAccessMode,
    pinnedSkills,
    streamId,
  } = params;
  const t0 = performance.now();
  const mark = (label: string) => {
    console.log(
      `[agent/prep] ${label}: ${Math.round(performance.now() - t0)}ms`,
    );
  };

  const [instance, chat] = await Promise.all([
    db.composioClawInstance.findUnique({
      where: { id: instanceId },
    }),
    db.chat.findUnique({
      where: { id: chatId },
    }),
  ]);

  if (!instance) {
    throw new Error("Instance not found");
  }
  if (!chat) {
    throw new Error("Chat not found");
  }

  // Derive a one-line heading from the first user prompt, shared across all
  // channels (web / telegram / cron). Only placeholders get renamed so a manual
  // rename is never overwritten. The heading is display-only (never sent to the
  // LLM), so it stores the real user text — no PII restore needed.
  if (isPlaceholderChatName(chat.name)) {
    const derivedName = deriveChatName(userMessage);
    if (derivedName) {
      await db.chat.update({
        where: { id: chat.id },
        data: { name: derivedName },
      });
      chat.name = derivedName;
    }
  }

  const user = await db.user.findUnique({
    where: { id: instance.userId },
    select: { timezone: true },
  });

  const userTimezone = user?.timezone ?? DEFAULT_TIMEZONE;
  mark("db: instance+chat+user");

  // Tier-1 skill index (§3.1): enabled trusted + verified skills for this
  // user (global or this instance), sorted by slug for byte-stability.
  // Untrusted skills never appear — they are pin-only (§5.1).
  const skillIndexRows = await db.skill.findMany({
    where: {
      userId: instance.userId,
      enabled: true,
      trustTier: { in: ["trusted", "verified"] },
      OR: [{ instanceId: null }, { instanceId }],
    },
    select: { slug: true, description: true, trustTier: true },
    orderBy: { slug: "asc" },
  });
  mark("db: skills index");

  // Pinned skills (§3.3): validate ownership (query scopes to this user) +
  // instance scope, then materialize instructions. Unknown, unowned,
  // disabled, or out-of-instance slugs are dropped silently.
  // loadedSkillSlugs is shared with fs tools: pinned slugs' references/ are
  // readable now; a mid-turn load_skill adds more slugs to the same Set.
  const { pins: validPins, loadedSlugs: loadedSkillSlugs } =
    await resolvePinnedSkills({
      userId: instance.userId,
      instanceId,
      chatId,
      source,
      slugs: pinnedSkills ?? [],
    });

  // Conversational consent (Phase 8): an affirmative reply to last turn's
  // install presentation pins the skill for this turn through the same path.
  // Silence or a changed subject never consents — default deny.
  const { pins: consentedPins } = await resolveConsentedSkills({
    userId: instance.userId,
    instanceId,
    chatId,
    source,
    userMessage,
  });
  for (const p of consentedPins) {
    if (!validPins.some((v) => v.slug === p.slug)) validPins.push(p);
    loadedSkillSlugs.add(p.slug);
  }

  const provider = getModelProvider(chat.model);
  const isOllama = provider === "ollama";
  const useAnthropicOptions = isAnthropicModel(chat.model);

  // ── File system access mode (Phase A) ──
  // Resolve ONCE, after the instance row is loaded and before tool assembly.
  // The instance row type includes the new columns via getInstanceForUser's
  // model, so this compiles once W1's schema fields exist.
  const fsMode = resolveFsMode(fsAccessMode, source, instance);
  console.log(
    `[fs] effective mode — instance=${instanceId} chat=${chatId} source=${source} requested=${fsAccessMode ?? "unset"} effective=${fsMode}`,
  );

  // Create a PII vault for non-local models to redact sensitive data
  // before it reaches the external LLM. Local Ollama models are exempt
  // since data stays on-device. Users can disable via Settings.
  const piiVault =
    !isOllama && instance.piiRedactionEnabled ? new PIIVault() : null;

  // The transport shield is the final network-layer checkpoint.
  // It shares the same vault so tokens are consistent across all layers
  // (tool results, context messages, system prompt, user message).
  const transportShield = piiVault ? new PIITransportShield(piiVault) : null;

  // Only run the (network) prep-time memory lookup when it's plausibly needed.
  // Conservative heuristic: skip for in-flow follow-ups (the agent can still
  // call memory_search itself), which removes a blocking call from the common
  // case and speeds up time-to-first-token.
  const relevantMemories = shouldLookupMemoriesForContext(userMessage)
    ? await searchMemoriesForContext(instanceId, userMessage)
    : [];
  mark("memory search");

  // Redact ONLY the dynamic user-supplied prompt sections (soul/identity/user),
  // so static content (agent title, tool descriptions, protocol, guidelines)
  // is passed through untouched — the agent name & product name must survive.
  // If not PII-redacting (local model / disabled), sections pass through as-is.
  const redactSection = async (
    section: string | null,
  ): Promise<string | null> =>
    section === null || section.trim() === ""
      ? section
      : transportShield
        ? await transportShield.scrubText(section)
        : section;

  const [safeSoul, safeIdentity, safeUser] = await Promise.all([
    redactSection(instance.soulPrompt),
    redactSection(instance.identityPrompt),
    redactSection(instance.userPrompt),
  ]);

  let systemPrompt = sanitizeString(
    buildSystemPrompt({
      soulPrompt: safeSoul,
      identityPrompt: safeIdentity,
      userPrompt: safeUser,
      hasCompactionSummary: !!chat.lastCompactionSummary,
      isOllama,
      piiEnabled: !!piiVault,
      isVoice: isVoice ?? false,
      fsReadEnabled: instance.fsReadEnabled,
      fsMode,
      availableSkills: skillIndexRows.map((r) => ({
        slug: r.slug,
        description: r.description,
        pinOnly: r.trustTier !== "trusted",
      })),
    }),
  );

  // §10.1 — one sentence per enabled MCP server, under 50 tokens each
  try {
    const mcpServersForPrompt = await db.mcpServer.findMany({
      where: { instanceId: instance.id, enabled: true },
      select: { label: true },
      take: 10,
    });
    if (mcpServersForPrompt.length > 0) {
      const block = [
        "Connected MCP servers for this project:",
        ...mcpServersForPrompt.map(
          (s) => `- ${s.label}: external tooling via MCP.`,
        ),
      ].join("\n");
      systemPrompt = `${systemPrompt}\n\n---\n\n${block}`;
    }
  } catch {
    // no-op — prompt without MCP block is still valid
  }
  const dbMessages = await loadContextMessages(
    instanceId,
    chatId,
    chat.lastCompactionAt,
  );
  const aiMessages = buildContext(
    dbMessages,
    chat.lastCompactionSummary,
    userMessage,
    {
      // Per-turn volatile context — stays OUT of the cached prefix (§3.1).
      // The static system prompt is byte-stable across turns, so only the
      // final user message changes between requests.
      relevantMemories,
      userTimezone,
      modeLines: buildVolatileModeLines({
        fsReadEnabled: instance.fsReadEnabled,
        fsMode,
        isVoice: isVoice ?? false,
      }),
    },
  );

  const contextWindow = getContextWindow(chat.model);
  const { messages: prunedMessages } = pruneContext(aiMessages, contextWindow);

  // Add cache breakpoint to last history message (before new user message)
  // so the conversation prefix is cached across turns.
  // Only apply Anthropic-specific cacheControl for Anthropic models —
  // non-Anthropic models (OpenAI, DeepSeek, Google) don't
  // understand this option and may reject the request.
  // Only user/assistant messages support cacheControl; tool messages reject it.
  if (useAnthropicOptions && prunedMessages.length >= 2) {
    const lastHistoryIndex = prunedMessages.length - 2;
    const msg = prunedMessages[lastHistoryIndex]!;
    if (msg.role === "user" || msg.role === "assistant") {
      prunedMessages[lastHistoryIndex] = {
        ...msg,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      };
    }
  }

  // Create Composio session and fetch tools BEFORE persisting the user
  // message, so a failed API call doesn't leave an orphaned user message.
  const decryptedApiKey = await (async () => {
    try {
      return instance.composioApiKey
        ? await decrypt(instance.composioApiKey)
        : null;
    } catch {
      throw new Error(
        "Failed to decrypt your Composio API key. The key may be corrupted. " +
          "Try re-entering it in Settings.",
      );
    }
  })();
  // Reuse a cached Composio tool-router session + tool list across turns for
  // this instance. This avoids re-invoking composio.create() + session.tools()
  // (2 network calls) on conversational follow-ups — the biggest pre-first-token
  // latency cost. Connection-status/connect flows keep fresh sessions and call
  // invalidateSession() to refresh this cache.
  const { rawTools: rawComposioTools } = await getOrCreateSessionAndTools(
    instance.id,
    decryptedApiKey,
    { manageConnections: { waitForConnections: true } },
  );
  mark("composio session+tools");

  // MCP tools — lazy, never throws, never blocks on network (cached schemas only)
  const { getOrCreateMcpTools } = await import("~/server/clients/mcp");
  const rawMcpTools = await getOrCreateMcpTools(instance.id, source);

  await db.message.create({
    data: {
      instanceId,
      chatId,
      role: "user",
      content: [{ type: "text", text: userMessage }],
      source,
      ...(userMessageType && { messageType: userMessageType }),
    },
  });
  // Trim verbose tool schemas to reduce token usage by ~40-60%.
  // This prevents free-tier TPM rate-limit errors with smaller models.
  // MCP goes before optimize so its schemas are also trimmed; customTools stay raw.
  const optimized = optimizeToolSchemas({
    ...rawComposioTools,
    ...rawMcpTools,
  });

  // Deterministic merge: tool KEYS are sorted so serialization is byte-stable
  // across requests (§3.2) — provider cache prefix cannot be invalidated by a
  // reordering session.tools()/MCP sync.
  // load_skill reports toolsAvailable/toolsMissing against the turn's real
  // ToolSet — populated with the assembled keys below, before wrapping.
  const skillToolNamesRef = { current: [] as string[] };
  const customTools = createCustomTools(instanceId, chatId, userTimezone, {
    fsReadEnabled: instance.fsReadEnabled,
    fsMode,
    fsRoot: instance.fsRootPath,
    instanceId,
    chatId,
    // Blast-radius budget for auto-writes (B1). One logical change per message.
    changeBudget: { remaining: MAX_AUTO_WRITES_PER_MESSAGE },
    // Pinned (and mid-turn loaded) skills' references/ stay readable.
    allowedSkillSlugs: loadedSkillSlugs,
  }, skillIndexRows.length > 0 || source === "web" ? {
    userId: instance.userId,
    instanceId,
    chatId,
    toolNamesRef: skillToolNamesRef,
    loadedSlugs: loadedSkillSlugs,
    hasIndex: skillIndexRows.length > 0,
    source,
  } : undefined);
  const allToolsUnordered: ToolSet = { ...optimized, ...customTools };
  const allTools: ToolSet = Object.fromEntries(
    Object.keys(allToolsUnordered)
      .sort()
      .map((k) => [k, allToolsUnordered[k]!]),
  ) as ToolSet;

  // Skill tool cap (§5.2): with a non-trusted skill pinned, the turn sees the
  // intersection of its ToolSet and the declared lists, plus the always-on
  // core. Trusted-only (or no) pins leave the set untouched. Computed before
  // the single wrapToolExecutors merge point — never mid-turn.
  const cappedTools = applySkillToolCap(
    allTools,
    validPins.map((p) => ({ trustTier: p.trustTier, toolsRequired: p.toolsRequired })),
  );
  skillToolNamesRef.current = Object.keys(cappedTools);

  // Pinned-skill tail blocks (§3.3): instruction text assembled against the
  // capped (real) ToolSet, appended post-shield so it is never redacted.
  let pinnedBlock: string | null = null;
  if (validPins.length > 0) {
    pinnedBlock = validPins
      .map((p) =>
        p.instructions === null || p.loadError
          ? `---\nPinned skill "${p.slug}" could not be loaded: ${p.loadError ?? "unknown error"}. Tell the operator and proceed without it.`
          : formatPinnedSkillBlock({
              slug: p.slug,
              displayName: p.displayName,
              instructions: p.instructions,
              stateScope: p.stateScope,
              toolsMissing: splitSkillTools(p.toolsRequired, skillToolNamesRef.current).toolsMissing,
              references: p.references,
              state: p.state,
            }),
      )
      .join("\n\n");
  }

  // Per-request cache of restored (real) tool-call inputs/outputs, keyed by
  // toolCallId (prefixed with "out:" for outputs). Ensures restoreDeep() is
  // called at most once per tool call — Composio execution, DB persistence,
  // and UI re-render all read the SAME cached value.
  const restoreCache = new Map<string, unknown>();

  // Wrap tool executors with sanitization + optional PII redaction.
  // When a vault is active, tool results are scanned for PII and
  // sensitive values are replaced with tokens before the LLM sees them.
  // One merge point — customTools last so they win on collision. allTools is
  // key-sorted (see above), and wrapping preserves that order.
  const agentTools: ToolSet = wrapToolExecutors(
    cappedTools,
    piiVault,
    restoreCache,
    {
      // fs_write/fs_edit carry content — never restore PII tokens into disk writes
      // find_skill queries leave for a third-party registry — tokens stay tokens
      noArgumentRestore: new Set(["fs_write", "fs_edit", "find_skill"]),
      // Results are pure filesystem structure — no scanning, no redaction.
      piiStructuralTools: new Set([
        "fs_list",
        "fs_find",
        "fs_mkdir",
        "fs_move",
        "fs_delete",
        // Skill instructions must reach the model verbatim — tokenizing the
        // operator's own authored content makes skills silently execute wrong.
        "load_skill",
      ]),
      // Scan only these fields; everything else passes through untouched.
      piiScanFieldsByTool: { fs_read: ["content"] },
    },
  );

  // Pre-create assistant message row so we can update it in onFinish
  const assistantMessageRow = await db.message.create({
    data: {
      instanceId,
      chatId,
      role: "assistant",
      content: toPrismaJson([]),
      source,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
  mark("message rows");

  const model = isOllama
    ? // Ollama needs provider-specific options (keep-alive, context size).
      ollamaProvider(chat.model, {
        keep_alive: -1,
        options: { num_ctx: getContextWindow(chat.model) },
      })
    : // All other providers (OpenRouter-routed DeepSeek/Gemini/GPT/Llama, bare
      // Anthropic) are built by the shared provider-agnostic helper.
      buildLLM(chat.model);

  // NOTE: The system prompt's user-supplied sections (soul/identity/user) were
  // already redacted above via redactSection(). Static sections (agent title,
  // tool descriptions, protocol, guidelines) are intentionally NOT scrubbed so
  // the agent name & product name are never tokenized.
  const safeSystemPrompt = systemPrompt;

  // Section 0.1 instrumentation — shared mutable metrics. ttftMs is recorded by
  // route.ts on the first SSE byte; genMs + payload accounting here in onFinish;
  // sectionTokens is filled once the final (redacted) message array exists.
  const metrics: RequestMetrics = {
    sectionTokens: null,
    ttftMs: null,
    genMs: null,
    startedAt: Date.now(),
  };

  const agent = new ToolLoopAgent({
    model,
    instructions: {
      role: "system",
      content: safeSystemPrompt,
      // Only inject Anthropic cacheControl for Anthropic models.
      // Other providers don't support this option.
      ...(useAnthropicOptions && {
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      }),
    } satisfies SystemModelMessage,
    tools: agentTools,
    // No per-prompt step ceiling — allow long-running tasks (e.g., 33-product scrape) to complete.
    // Hard ceiling removed per user request; relies on model natural termination and Vercel maxDuration (300s).
    stopWhen: stepCountIs(100),
    // Disable Qwen3 thinking mode to prevent empty-output errors
    // and cut token generation time in half.
    // No maxTokens cap: replies and tool calls stream until the model stops
    // naturally (bounded by stopWhen below and the route maxDuration).
    ...(isOllama && {
      providerOptions: {
        ollama: { think: false },
      },
    }),
    // Reasoning guidance per step (OpenRouter only, effort only — no token
    // caps): step 0 plans the task, every later step just picks the next
    // directory/tool and doesn't need 200 words of deliberation. No
    // maxOutputTokens ceiling either, so long-form answers (e.g. raw commit
    // histories) are never cut mid-tool-call — a truncation inside a
    // tool-call block yields malformed args, a retry, and a phantom
    // duplicate in the UI.
    ...(provider === "openrouter" && {
      prepareStep: ({ stepNumber }) => ({
        providerOptions: {
          openrouter: {
            reasoning: { effort: stepNumber === 0 ? "medium" : "low" },
          },
        },
      }),
    }),
    // Per-step truncation signal: we set no output ceiling, so any `length`
    // finish comes from the provider side — log it with run context.
    onStepFinish: async (event) => {
      const reason = (event as { finishReason?: unknown }).finishReason;
      if (reason === "length") {
        console.warn("[agent/step] truncated by output limit", {
          instanceId,
          chatId,
          source,
          model: chat.model,
        });
      }
    },
    onFinish: async (result) => {
      // The run reached a terminal state — stop the heartbeat so the Redis
      // pointer is no longer refreshed (missing key reads as terminal).
      if (streamId) {
        releaseRun(streamId);
        // Final vault mappings (including streaming registrations) so any
        // resumed replay restores tokens. Left to TTL expiry — post-completion
        // resumes that still find stream data need it.
        if (piiVault) {
          await persistVaultSnapshot(streamId, piiVault).catch((error) =>
            console.error("[agent/onFinish] vault snapshot failed:", error),
          );
        }
        await releaseChatRun(chatId, streamId).catch((error) =>
          console.error("[agent/onFinish] releaseChatRun failed:", error),
        );
      } else {
        await clearStreamingMessage(chatId).catch((error) =>
          console.error(
            "[agent/onFinish] clearStreamingMessage failed:",
            error,
          ),
        );
      }
      try {
        const { totalUsage, steps, finishReason } = result;
        const inputTokens = totalUsage.inputTokens ?? 0;
        const outputTokens = totalUsage.outputTokens ?? 0;
        const cacheReadTokens =
          totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
        const cacheWriteTokens =
          totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0;

        // Build assistant content from steps (UIMessage parts format)
        const assistantParts: Array<Record<string, unknown>> = [];

        // §4.1 — full tool-result persistence, keyed by tool-call id, written
        // once per run. This is what makes every §4 reduction addressable.
        const persistedToolResults: Array<{
          instanceId: string;
          chatId: string;
          callId: string;
          toolName: string;
          payload: unknown;
        }> = [];

        for (const step of steps) {
          // Persist reasoning BEFORE tool calls so chainItems order is thinking → acting
          const stepReasoning =
            step.reasoningText ??
            (step.reasoning?.length
              ? step.reasoning
                  .map((r) => (r as { text?: string }).text ?? "")
                  .filter(Boolean)
                  .join("\n")
              : "");
          if (stepReasoning) {
            const restoredReasoning = stripResidualTokens(
              piiVault ? piiVault.restore(stepReasoning) : stepReasoning,
            );
            const gloss = extractReasoningGloss(restoredReasoning);
            assistantParts.push({
              type: "reasoning" as const,
              text: restoredReasoning,
              gloss: gloss ?? undefined,
              state: "done" as const,
            } as Record<string, unknown>);
          }

          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const tr = step.toolResults[i];
            const rawInput = toPlainRecordSafe(tc.input);
            const rawOutput = tr ? toPlainRecordSafe(tr.output) : null;
            const tid = tc.toolCallId;

            // Use the CACHED restored value (set once by wrapToolExecutors during
            // execution) so DB persistence stores the exact same value the tool saw,
            // without a second restoreDeep() per tool call. Falls back to restoring
            // now if the cache misses (e.g. tool executed outside the wrapper).
            const tcInput = piiVault
              ? ((restoreCache.get(tid) ??
                  piiVault.restoreDeep(rawInput)) as Record<string, unknown>)
              : rawInput;
            const tcResult = rawOutput
              ? piiVault
                ? ((restoreCache.get(`out:${tid}`) ??
                    piiVault.restoreDeep(rawOutput)) as Record<string, unknown>)
                : rawOutput
              : null;

            assistantParts.push({
              type: "dynamic-tool" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              display_name: formatToolDisplayName(tc.toolName),
              state: tcResult ? "output-available" : "input-available",
              input: tcInput,
              output: tcResult ?? {},
            });
            if (tcResult !== null && tcResult !== undefined) {
              persistedToolResults.push({
                instanceId,
                chatId,
                callId: tc.toolCallId,
                toolName: tc.toolName,
                payload: toPlainRecordSafe(tcResult),
              });
            }
          }

          const stepText = stripToolResultEchoes(step.text);
          if (stepText) {
            // Restore PII tokens back to original values before persisting.
            // The database stores real data; only the LLM saw redacted tokens.
            // Strip any residual (orphan) token restore() cannot resolve so
            // the transcript never stores a raw placeholder that would re-leak.
            const restoredText = stripResidualTokens(
              piiVault ? piiVault.restore(stepText) : stepText,
            );
            assistantParts.push({ type: "text" as const, text: restoredText });
          }
        }

        // Append truncation notice for Ollama models when the response
        // was cut off by the maxTokens limit.
        if (isOllama && finishReason === "length") {
          assistantParts.push({
            type: "text" as const,
            text: "\n\n[Response was truncated due to length limits]",
          });
        }

        // §4.1 — persist full results before the message update. Non-fatal: a
        // failed write just means that run's results are unreachable by
        // read_tool_result (history still carries the in-context copies).
        if (persistedToolResults.length > 0) {
          await db.toolResult
            .createMany({
              data: persistedToolResults.map((r) => ({
                instanceId: r.instanceId,
                chatId: r.chatId,
                callId: r.callId,
                toolName: r.toolName,
                payload: toPrismaJson(r.payload),
              })),
              skipDuplicates: true,
            })
            .catch((err: unknown) =>
              console.error("[agent/tool-result] persistence failed:", err),
            );
        }

        // Skill state persistence (Phase 6): in-band ```skill-state <slug>
        // blocks from stateful skills loaded or pinned this turn. Structured
        // procedure data — never the pgvector memory system. Never throws.
        try {
          const assistantText = assistantParts
            .filter((p) => p.type === "text")
            .map((p) => p.text as string)
            .join("\n");
          const updates = extractSkillStateUpdates(assistantText);
          if (updates.length > 0) {
            const stateful = new Map<string, { skillId: string; stateScope: string }>();
            for (const p of validPins) {
              if (p.stateScope === "session" || p.stateScope === "persistent") {
                stateful.set(p.slug, { skillId: p.skillId, stateScope: p.stateScope });
              }
            }
            if (loadedSkillSlugs.size > 0) {
              const rows = await db.skill.findMany({
                where: {
                  userId: instance.userId,
                  slug: { in: [...loadedSkillSlugs] },
                  stateScope: { in: ["session", "persistent"] },
                },
                select: { id: true, slug: true, stateScope: true },
              });
              for (const r of rows) {
                stateful.set(r.slug, { skillId: r.id, stateScope: r.stateScope });
              }
            }
            for (const u of updates) {
              const target = stateful.get(u.slug);
              // State for a skill not loaded this turn is ignored.
              if (!target) continue;
              await saveSkillState({
                skillId: target.skillId,
                stateScope: target.stateScope,
                chatId,
                instanceId,
                data: u.data,
              });
            }
          }
        } catch (err) {
          console.error("[skills/state] persistence failed:", err);
        }

        // Update the pre-created assistant message with final content + totals
        metrics.genMs = Date.now() - metrics.startedAt;
        const finishReasonStr =
          typeof finishReason === "string" ? finishReason : null;
        await db.message.update({
          where: { id: assistantMessageRow.id },
          data: {
            content: toPrismaJson(assistantParts),
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            sectionTokens: toPrismaJson(metrics.sectionTokens ?? {}),
            ttftMs: metrics.ttftMs,
            genMs: metrics.genMs,
            finishReason: finishReasonStr,
            runStatus: finishReasonStr === "error" ? "failed" : "completed",
          },
        });

        // Section 0.1 instrumentation — one line per LLM request. Estimated
        // section splits let each token-efficiency phase be attributed.
        console.log(
          "[agent/tokens]",
          JSON.stringify({
            instanceId,
            chatId,
            source,
            model: chat.model,
            provider,
            sections: metrics.sectionTokens,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cacheHit: cacheReadTokens > 0,
            ttftMs: metrics.ttftMs,
            genMs: metrics.genMs,
            finishReason: finishReasonStr,
            stepIndex: steps.length,
          }),
        );

        // Fire-and-forget post-response tasks
        const totalContextTokens = inputTokens + outputTokens;
        // For qwen3:8b (32K context), use smaller reserve/keep windows so we
        // leave more of the context for actual conversation history.
        const ollamaCompactionSettings = {
          reserveTokens: 8_000,
          keepRecentTokens: 8_000,
        };
        const settings: CompactionSettings = {
          contextWindow,
          ...(isOllama
            ? ollamaCompactionSettings
            : DEFAULT_COMPACTION_SETTINGS),
        };

        void after(() =>
          runPostResponseTasks({
            instanceId,
            chatId,
            chat: {
              anthropicModel: chat.model,
              compactionCount: chat.compactionCount,
              compactionAttempts: chat.compactionAttempts,
              memoryFlushCount: chat.memoryFlushCount,
              lastCompactionSummary: chat.lastCompactionSummary,
              lastCompactionAt: chat.lastCompactionAt,
            },
            contextTokens: totalContextTokens,
            settings,
            prunedMessages,
            piiVault,
          }).catch((error) =>
            console.error(
              "[agent/onFinish] post-response tasks failed:",
              error,
            ),
          ),
        );
      } catch (error) {
        console.error("[agent/onFinish] post-stream processing failed:", error);
      }
    },
  });

  // Create a deep-cloned array with redacted text for the LLM prompt.
  // We keep the original `prunedMessages` above for runPostResponseTasks.
  let redactedMessages = piiVault
    ? await redactContextMessages(prunedMessages, piiVault)
    : prunedMessages;

  // ── Final transport-layer checkpoint ──
  // After all per-layer redaction, run one final deep-scrub on the
  // fully-assembled message array. This catches any PII that leaked
  // through tool results, reasoning text, or partial redaction gaps.
  // The shield shares the same PIIVault, so tokens stay consistent.
  if (transportShield) {
    redactedMessages = (await transportShield.scrubPayload(
      redactedMessages as any,
    )) as typeof redactedMessages;
  }

  // Pinned skills bypass the tool path (§3.3) so they never saw the vault or
  // the shield — append here, verbatim, onto the volatile tail (Fix B).
  if (pinnedBlock) {
    const last = redactedMessages[redactedMessages.length - 1];
    if (last?.role === "user" && typeof last.content === "string") {
      redactedMessages[redactedMessages.length - 1] = {
        ...last,
        content: `${last.content}\n\n${pinnedBlock}`,
      };
    } else {
      redactedMessages.push({
        role: "user" as const,
        content: sanitizeString(pinnedBlock),
      });
    }
  }
  metrics.sectionTokens = estimateSectionTokens(
    safeSystemPrompt,
    cappedTools,
    redactedMessages,
  );
  mark("setup complete (pre-first-token)");

  return {
    status: "ready",
    result: {
      agent,
      messages: redactedMessages,
      piiVault,
      assistantMessageId: assistantMessageRow.id,
      metrics,
    },
  };
}

export type {
  PrepareAgentRunParams,
  PrepareResult,
  PrepareAgentRunResult,
  MessageSource,
};
