import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Skills root — writable, outside the repo, same location family as the run
 * journal. Override with JARVIS_SKILLS_DIR (tests, scratch harnesses).
 * Returned realpathed so prefix comparison against realpathed fs paths holds
 * (e.g. /var → /private/var on macOS). Falls back unresolved when the dir
 * does not exist yet.
 */
export function getSkillsRoot(): string {
  const override = process.env.JARVIS_SKILLS_DIR?.trim();
  let p: string;
  if (override) {
    p = override;
  } else if (platform() === "darwin") {
    p = join(homedir(), "Library", "Application Support", "NimitsJarvis", "skills");
  } else if (platform() === "win32" && process.env.APPDATA) {
    p = join(process.env.APPDATA, "NimitsJarvis", "skills");
  } else {
    p = join(homedir(), ".local", "share", "nimits-jarvis", "skills");
  }
  try {
    // Runtime data dir outside the repo — never a build-time asset, so opt
    // out of Turbopack's whole-project filesystem tracing for this call.
    return realpathSync(/*turbopackIgnore: true*/ p);
  } catch {
    return p;
  }
}

/** Absolute dir for one skill slug. Slug is validated at parse time. */
export function getSkillDir(root: string, slug: string): string {
  return join(root, slug);
}
