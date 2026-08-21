export type Reachability = "loopback" | "private" | "remote";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BLOCKED = new Set(["169.254.169.254", "metadata.google.internal"]);

export function assertSafeMcpUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("MCP server URL must be http or https");
  }
  if (BLOCKED.has(u.hostname)) {
    throw new Error("That address is not permitted");
  }
  return u;
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
