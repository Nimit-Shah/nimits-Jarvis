export type Reachability = "loopback" | "private" | "remote";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Static first layer for well-known metadata hosts (AWS/GCP). Everything else
// is enforced by the resolved-address check below, which also defeats
// DNS-rebinding and nip.io-style names.
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

export type HostClass = "loopback" | "private" | "global";

function classifyIpv4(ip: string): HostClass {
  const m = IPV4_OCTETS.exec(ip);
  if (!m) return "global"; // not an IP literal — resolved by DNS later
  const [a, b, c, d]: [number, number, number, number] = [
    Number(m[1] ?? "0"),
    Number(m[2] ?? "0"),
    Number(m[3] ?? "0"),
    Number(m[4] ?? "0"),
  ];
  if ([a, b, c, d].some((x) => x > 255)) return "global"; // URL parsed it as a hostname
  if (a === 127) return "loopback";
  if (a === 0 || a === 10) return "private"; // 0.0.0.0/8, 10.0.0.0/8
  if (a === 169 && b === 254) return "private"; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 shared space
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "private"; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return "private"; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return "private"; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return "private"; // 203.0.113.0/24
  if (a >= 224) return "private"; // multicast (224/4) + reserved (240/4)
  return "global";
}

/** Classify an address literal (IPv4, IPv6, or IPv4-mapped-IPv6). */
export function classifyHostAddress(hostname: string): HostClass {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (h.includes(":")) {
    if (h === "::1") return "loopback";
    if (h === "::") return "private"; // unspecified
    if (h.startsWith("fe8")) return "private"; // fe80::/10 link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return "private"; // fc00::/7 unique-local
    if (h.startsWith("2001:db8")) return "private"; // documentation range
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const high = parseInt(mapped[1] ?? "", 16);
      const low = parseInt(mapped[2] ?? "", 16);
      return classifyIpv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
    }
    const v4in6 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (v4in6 && v4in6[1]) return classifyIpv4(v4in6[1]);
    return "global";
  }
  if (IPV4_OCTETS.test(h)) return classifyIpv4(h);
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback"; // RFC 6761
  return "global"; // hostname — enforced by resolution check at connect time
}

/**
 * Reject http(s) URLs that are not permitted. By default only globally
 * routable destinations (or resolvable hostnames, checked separately at
 * connect time) pass; `allowLoopback` keeps the supervised local MCP /
 * browser-daemon flow working (loopback children are spawned by this host).
 */
export function assertSafeMcpUrl(raw: string, opts?: { allowLoopback?: boolean }): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("MCP server URL must be http or https");
  }
  const hostname = u.hostname;
  if (hostname.endsWith(".")) {
    throw new Error("That address is not permitted");
  }
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error("That address is not permitted");
  }
  const cls = classifyHostAddress(hostname);
  if (cls === "private" || (cls === "loopback" && opts?.allowLoopback !== true)) {
    throw new Error("That address is not permitted");
  }
  return u;
}

/**
 * Resolve a hostname and reject it unless every answer is a globally
 * routable address (or loopback, when allowed). Defeats DNS-rebinding and
 * nip.io-style names that pass the string checks but resolve to private,
 * loopback or link-local targets (incl. cloud metadata).
 */
export async function assertMcpHostResolvesGlobal(
  raw: string,
  opts?: { allowLoopback?: boolean },
): Promise<void> {
  const u = assertSafeMcpUrl(raw, opts);
  const hostname = u.hostname;
  if (hostname.includes(":") || IPV4_OCTETS.test(hostname)) return; // IP literal — classified synchronously above
  const { promises } = await import("node:dns");
  let results: unknown;
  try {
    results = await promises.lookup(hostname, { family: 0 });
  } catch {
    throw new Error("Host does not resolve");
  }
  const rawAnswers = Array.isArray(results) ? results : results ? [results] : [];
  const addrs = rawAnswers.filter(
    (r: unknown): r is { address: string } =>
      typeof r === "object" && r !== null && typeof (r as { address?: unknown }).address === "string",
  );
  if (addrs.length === 0) throw new Error("Host does not resolve");
  for (const a of addrs) {
    const cls = classifyHostAddress(a.address);
    if (cls === "private" || (cls === "loopback" && opts?.allowLoopback !== true)) {
      throw new Error("That address is not permitted");
    }
  }
}

/**
 * fetch() that re-validates every redirect hop against the SSRF guard.
 * Redirects are denied outright (undici `redirect: "error"` throws before the
 * 3xx response is handed back), so a redirect can never land on a
 * non-permitted host. Endpoints that legitimately redirect must be configured
 * with their final URL instead.
 */
export async function safeRedirectFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  guard?: { allowLoopback?: boolean },
): Promise<Response> {
  const url = input instanceof URL ? input.href : new URL(String(input)).href;
  await assertMcpHostResolvesGlobal(url, guard);
  return fetch(url, { ...init, redirect: "error" });
}

export function classifyReachability(raw: string): Reachability {
  const { hostname } = new URL(raw);
  if (LOOPBACK.has(hostname)) return "loopback";
  if (/^10\./.test(hostname)) return "private";
  if (/^192\.168\./.test(hostname)) return "private";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return "private";
  return "remote";
}

export function isReachableHere(r: Reachability): boolean {
  const serverless = Boolean(process.env.VERCEL);
  return r === "remote" ? true : !serverless;
}
