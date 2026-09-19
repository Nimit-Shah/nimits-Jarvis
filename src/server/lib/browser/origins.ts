/**
 * Origin-pattern normalization + expansion for browser MCP allowlists.
 *
 * Evidence (Phase 0 probe vs TradingView, Playwright MCP 1.64):
 * - bare `tradingview.com` → matches apex only (even www navigation blocked)
 * - `*.tradingview.com` → matches all subdomains (`*` crosses dots)
 * - full URL `https://tradingview.com` → apex only, scheme-locked
 * - exact enumeration works but rots on first unseen subdomain
 *   (s3-symbol-logo.tradingview.com broke 140 images)
 *
 * Rule: store bare sites, expand to [apex, *.apex] at launch.
 */

/** Strip scheme/path/query, lowercase host, keep explicit ports. */
export function normalizeOriginPattern(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) throw new Error("Empty origin pattern.");
  const withoutScheme = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const hostPort = withoutScheme.split(/[/?#]/, 1)[0];
  if (!hostPort || /\s/.test(hostPort)) throw new Error(`Invalid origin pattern: ${raw}`);
  const bare = hostPort.replace(/^\*\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(bare)) {
    throw new Error(`Invalid origin pattern: ${raw} (expected a bare site like tradingview.com)`);
  }
  return bare;
}

/**
 * Expand a stored entry into the launch patterns passed to Playwright MCP.
 * - Bare site → apex exact + subdomain wildcard (`*.` crosses dots; apex
 *   coverage under `*.` is unconfirmed, so both are passed).
 * - `*.site` → wildcard only.
 * - Full URL with scheme → passed through untouched (apex-only,
 *   scheme-locked semantics, per probe trial C).
 */
export function expandOriginPatterns(entry: string): string[] {
  const t = entry.trim().toLowerCase();
  if (!t) throw new Error("Empty origin pattern.");
  if (t.startsWith("*.")) return [`*.${normalizeOriginPattern(t)}`];
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) return [t];
  const bare = normalizeOriginPattern(t);
  return [bare, `*.${bare}`];
}
