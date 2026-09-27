/**
 * Browser target keys — one target per browser, never per row. Managed and
 * extension rows on one MCP port contend for one child; CDP rows contend
 * per endpoint. Two targets that share nothing never contend.
 *
 * Dedication invariant: exactly one McpServer row may occupy a target
 * (enforced at write time by the dedication guard + at runtime by the
 * daemon's shared-group refusal). This function is the SINGLE key
 * implementation for all three consumers (tool-call mutex, write guard,
 * daemon grouping) — they must never disagree (pinned by unit test).
 */
export function browserTargetFor(row: {
  browserMode?: string | null;
  url: string;
  cdpEndpoint?: string | null;
}): string | null {
  if (row.browserMode === "cdp") {
    const canonical = canonicalCdpEndpoint(row.cdpEndpoint);
    if (!canonical) return null;
    return `cdp:${canonical}`;
  }
  try {
    const u = new URL(row.url);
    const port = Number(u.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return `port:${port}`;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a CDP endpoint so textual variants of the same browser
 * collapse to one key: scheme/host lowercased, localhost/127.0.0.1/::1
 * unified, default ports + trailing slashes + query/fragment dropped.
 * Unparseable input falls back to the trimmed raw string (never null a
 * configured endpoint — fail-closed happens at the guard, not here).
 */
export function canonicalCdpEndpoint(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    let host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      host = "loopback";
    }
    const scheme = u.protocol.toLowerCase();
    const defaultPort = scheme === "http:" ? "80" : scheme === "https:" ? "443" : "";
    let out = `${scheme}//${host}`;
    if (u.port && u.port !== defaultPort) out += `:${u.port}`;
    const path = u.pathname.replace(/\/+$/, "");
    if (path) out += path;
    return out;
  } catch {
    return trimmed;
  }
}
