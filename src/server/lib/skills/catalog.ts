import type { RegistryCandidate } from "./cli-search";

const API_BASE = "https://skills.sh/api/v1";
const API_TIMEOUT_MS = 15_000;
const API_SEARCH_LIMIT = 10;

export interface SkillFileSnapshot {
  path: string;
  contents: string;
}

export interface SkillDetail {
  id: string;
  source: string;
  slug: string;
  installs: number;
  hash: string | null;
  files: SkillFileSnapshot[] | null;
}

export interface SkillAudit {
  provider: string;
  status: string;
  summary: string;
  riskLevel?: string;
  auditedAt?: string;
}

/**
 * skills.sh API v1 client — the fallback/enrichment path, never the default.
 * Token is read per call (12h rotation, never cached). Any failure (no
 * token, 401/429/network) returns null so callers degrade gracefully; it
 * never throws into tool executors.
 */
function token(): string | null {
  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? null;
}

async function get<T>(path: string): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ApiSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  installUrl?: string | null;
  url?: string;
  description?: string;
  isDuplicate?: boolean;
}

export async function searchSkillsApi(
  query: string,
  opts?: { owner?: string; limit?: number },
): Promise<RegistryCandidate[] | null> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    q,
    limit: String(opts?.limit ?? API_SEARCH_LIMIT),
    ...(opts?.owner ? { owner: opts.owner } : {}),
  });
  const res = await get<{ data: ApiSkill[] }>(`/skills/search?${params}`);
  if (!res) return null;
  return res.data
    .filter((s) => !s.isDuplicate)
    .map((s) => ({
      slug: s.slug,
      source: s.id,
      description: s.description,
      installs: s.installs,
      url: s.url,
    }));
}

export async function getSkillDetail(
  id: string,
): Promise<SkillDetail | null> {
  // id is always {source}/{slug} built from validated parts, never raw input.
  return get<SkillDetail>(`/skills/${id}`);
}

export async function getSkillAudits(
  id: string,
): Promise<SkillAudit[] | null> {
  const res = await get<{ audits: SkillAudit[] }>(`/skills/audit/${id}`);
  return res ? res.audits : null;
}
