import { db } from "~/server/clients/db";
import { materializeSkill } from "./materialize";
import type { ResolvedPin } from "./pins";

/**
 * Deterministic affirmative matcher for Phase-8 consent. This is consent
 * parsing, not a skill classifier: it never selects skills, it only answers
 * "did the operator say yes". Default-deny — silence, ambiguity, and
 * "yes, but…" with substantive content are not consent.
 */
const AFFIRMATIVE_RES = [
  /^(yes|yeah|yep|yup|sure|ok|okay|confirmed|confirm|proceed|agreed)\b[.!]*$/i,
  /^(go ahead|do it|use it|install it|please do|let'?s do it|sounds good)\b[.!]*$/i,
];

// Short "yes, …" continuations ("yes, use it") confirm; questions, "but …",
// and substantive content do not. Bounded so a paragraph starting with
// "yes" can never read as consent.
const LEAD_RE = /^(yes|yeah|yep|yup|sure|ok|okay)\b[,.]?\s+/i;
const CONTINUATION_DENY_RE = /[?]|(\b(but|however|although|though|wait|actually|first|instead|explain|what|why|how)\b)/i;
const MAX_REPLY_CHARS = 120;
const MAX_CONTINUATION_CHARS = 30;

export function isAffirmativeReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_REPLY_CHARS) return false;
  if (AFFIRMATIVE_RES.some((re) => re.test(t))) return true;
  const lead = LEAD_RE.exec(t);
  if (!lead) return false;
  const rest = t.slice(lead[0].length);
  if (!rest || rest.length > MAX_CONTINUATION_CHARS) return false;
  if (CONTINUATION_DENY_RE.test(rest)) return false;
  return true;
}

const DECLINE_RES = [
  /\b(no|don'?t|do not|stop|cancel|never mind|not now)\b/i,
];

export function isDeclineReply(text: string): boolean {
  return DECLINE_RES.some((re) => re.test(text));
}

/**
 * Resolve consented auto-installs for this turn. A pending consent fires
 * only when it is newer than the chat's latest assistant message (i.e. this
 * user message is the single next reply after the install presentation) and
 * the reply is affirmative. Anything else leaves it pending (or declined),
 * and the skill stays installed but unused.
 */
export async function resolveConsentedSkills(opts: {
  userId: string;
  instanceId: string;
  chatId: string;
  source: string;
  userMessage: string;
}): Promise<{ pins: ResolvedPin[] }> {
  const pins: ResolvedPin[] = [];
  if (opts.source !== "web") return { pins };
  if (!isAffirmativeReply(opts.userMessage)) {
    if (isDeclineReply(opts.userMessage)) {
      await db.skillConsent.updateMany({
        where: { chatId: opts.chatId, status: "pending" },
        data: { status: "declined" },
      });
    }
    return { pins };
  }

  const pending = await db.skillConsent.findMany({
    where: { chatId: opts.chatId, status: "pending" },
  });
  if (pending.length === 0) return { pins };

  for (const consent of pending) {
    // Freshness, exact: the current reply must be the FIRST user message
    // since the install. Any intervening exchange means the operator moved
    // on — the pending goes stale and never auto-fires. (The current user
    // message is not yet persisted at this point in prepareAgentRun, so a
    // zero count means this reply is the immediate next one.)
    const intervening = await db.message.count({
      where: {
        chatId: opts.chatId,
        role: "user",
        createdAt: { gt: consent.updatedAt },
      },
    });
    if (intervening > 0) {
      continue;
    }
    const skill = await db.skill.findUnique({
      where: { userId_slug: { userId: opts.userId, slug: consent.slug } },
    });
    if (!skill?.enabled) continue;
    // instanceId null = global to every project for this user.
    if (typeof skill.instanceId === "string" && skill.instanceId !== opts.instanceId) {
      continue;
    }
    const m = await materializeSkill(skill, {
      chatId: opts.chatId,
      instanceId: opts.instanceId,
    });
    if (!m.ok) continue;
    pins.push({
      skillId: skill.id,
      slug: skill.slug,
      displayName: skill.displayName,
      trustTier: skill.trustTier,
      stateScope: skill.stateScope,
      toolsRequired: m.materialized.toolsRequired,
      instructions: m.materialized.instructions,
      loadError: null,
      references: m.materialized.references,
      state: m.materialized.state,
    });
    await db.skillConsent.update({
      where: { id: consent.id },
      data: { status: "confirmed" },
    });
  }
  return { pins };
}
