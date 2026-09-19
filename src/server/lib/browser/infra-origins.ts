/**
 * Shared-infrastructure origin seed for browser MCP allowlists.
 *
 * Asset CDNs only — fonts, icons, JS libraries, static image hosts. These
 * are loaded by a large share of the web, so harvesting them per site means
 * adding the same hosts over and over. The seed applies to every server in
 * `allowlist` mode unless the operator opts out; per-site rules stay in
 * McpOriginRule.
 *
 * Deliberate omissions (do not "complete" this list): google-analytics.com,
 * googletagmanager.com, doubleclick.net and every other measurement/ad host
 * — pages render without them. p.typekit.net is Adobe's tracking beacon,
 * not a font host — use.typekit.net (kept) serves the actual assets.
 *
 * Note: gstatic.com is a SEPARATE registrable domain from google.com. The
 * `*.google.com` expansion cannot reach it — this is the single most common
 * instance of the apex-vs-CDN trap, and why the seed exists.
 * googleusercontent.com serves static user-content images (no authenticated
 * function behind it), hence its place here.
 */

export const INFRA_ORIGIN_SEED = {
  fonts: [
    "fonts.googleapis.com", // stylesheets
    "fonts.gstatic.com", // woff2 files
    "use.typekit.net", // Adobe Fonts assets
    "use.fontawesome.com", // Font Awesome kits
  ],
  libraries: ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "ajax.googleapis.com"],
  googleStatic: [
    "gstatic.com", // apex + subdomains via existing expansion
    "googleusercontent.com", // user/profile images
  ],
} as const;

export type InfraSeedEntry = (typeof INFRA_ORIGIN_SEED)[keyof typeof INFRA_ORIGIN_SEED][number];

/** Flat list, for launch-union and Settings display. */
export function infraSeedFlat(): string[] {
  return [...INFRA_ORIGIN_SEED.fonts, ...INFRA_ORIGIN_SEED.libraries, ...INFRA_ORIGIN_SEED.googleStatic];
}

/** True when the pattern is already covered by the enabled seed. */
export function coveredBySeed(pattern: string, excluded: readonly string[] = []): boolean {
  const t = pattern.trim().toLowerCase();
  // Full origins/URLs reduce to their host; bare entries compare directly.
  const host = (/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t.split("/", 3)[2] : t.split("/", 1)[0]) ?? t;
  const bare = host.replace(/^\*\./, "");
  return infraSeedFlat().some((s) => !excluded.includes(s) && (bare === s || bare.endsWith(`.${s}`)));
}
