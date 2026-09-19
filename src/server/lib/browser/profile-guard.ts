import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Refuse userDataDir values that resolve inside a main browser's default
 * profile tree. The agent ingests attacker-controlled text (Gmail, Slack);
 * pointing it at a live profile hands it every authenticated session.
 * Dedicated directories only — validated by realpath containment, not
 * string matching.
 */
const DEFAULT_BROWSER_TREES = [
  join("Library", "Application Support", "Google", "Chrome"),
  join("Library", "Application Support", "Comet"),
  join("Library", "Application Support", "BraveSoftware"),
  join("Library", "Application Support", "Microsoft Edge"),
  join(".config", "google-chrome"),
  join(".config", "BraveSoftware"),
];

export function validateDedicatedProfileDir(raw: string): { ok: true; real: string } | { ok: false; message: string } {
  const expanded = raw.startsWith("~") ? join(/*turbopackIgnore: true*/ homedir(), raw.slice(1)) : raw;
  let real: string;
  try {
    // Runtime operator path — never a build-time asset, so opt out of
    // Turbopack's whole-project filesystem tracing for these calls.
    real = realpathSync(/*turbopackIgnore: true*/ expanded);
  } catch {
    // Non-existent is fine — the daemon creates it. Resolve the parent.
    try {
      const parent = expanded.split(sep).slice(0, -1).join(sep) || sep;
      real = join(/*turbopackIgnore: true*/ realpathSync(/*turbopackIgnore: true*/ parent), expanded.split(sep).at(-1) ?? "");
    } catch {
      return { ok: false, message: `Profile directory is not resolvable: ${raw}` };
    }
  }
  const home = realpathSync(/*turbopackIgnore: true*/ homedir());
  for (const tree of DEFAULT_BROWSER_TREES) {
    const abs = realpathSyncSafe(join(/*turbopackIgnore: true*/ home, tree)) ?? join(/*turbopackIgnore: true*/ home, tree);
    if (real === abs || real.startsWith(abs + sep)) {
      return {
        ok: false,
        message:
          `Refused: ${raw} resolves inside your main browser's profile tree. ` +
          `Use a dedicated directory (e.g. ~/.jarvis/browser-profile) and sign in there via the "Open profile for login" action instead.`,
      };
    }
  }
  return { ok: true, real };
}

function realpathSyncSafe(p: string): string | null {
  try {
    return realpathSync(/*turbopackIgnore: true*/ p);
  } catch {
    return null;
  }
}
