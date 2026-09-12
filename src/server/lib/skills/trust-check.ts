import { getSkillAudits } from "./catalog";
import type { RegistryCandidate } from "./cli-search";

export type TrustVerdict = "pass" | "warn" | "disqualify";

export interface TrustCheck {
  verdict: TrustVerdict;
  reasons: string[];
}

/**
 * Pre-install trust check on a registry candidate. Audit verdicts (when the
 * API token is configured) can disqualify; heuristics warn but never block —
 * the §5.3 content scan still judges the body after install, and the row
 * always lands untrusted regardless.
 */
export async function checkCandidateTrust(
  candidate: RegistryCandidate,
): Promise<TrustCheck> {
  const reasons: string[] = [];
  let verdict: TrustVerdict = "pass";

  const audits = await getSkillAudits(candidate.source);
  if (audits) {
    for (const a of audits) {
      const risky =
        a.status === "fail" ||
        a.riskLevel === "HIGH" ||
        a.riskLevel === "CRITICAL";
      if (risky) {
        return {
          verdict: "disqualify",
          reasons: [
            `Security audit ${a.status} by ${a.provider}${a.riskLevel ? ` (risk ${a.riskLevel})` : ""}: ${a.summary}`,
          ],
        };
      }
      if (a.status === "warn") {
        verdict = "warn";
        reasons.push(`Audit warning by ${a.provider}: ${a.summary}`);
      }
    }
    if (verdict === "pass") {
      reasons.push(`Audits pass (${audits.length} partner${audits.length === 1 ? "" : "s"}).`);
    }
  } else {
    reasons.push("No third-party audits on record — content scan still applies after install.");
  }

  if ((candidate.installs ?? 0) < 100) {
    if (verdict === "pass") verdict = "warn";
    reasons.push(
      `Low install count (${candidate.installs ?? 0}) — treat with skepticism per source-reputation guidance.`,
    );
  }

  return { verdict, reasons };
}
