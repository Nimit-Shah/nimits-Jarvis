import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Attachments root — archival originals + sent derivatives live OUTSIDE the
 * repo, alongside the journal and skills. Override with
 * JARVIS_ATTACHMENTS_DIR (tests, scratch harnesses).
 */
export function getAttachmentsRoot(): string {
  const override = process.env.JARVIS_ATTACHMENTS_DIR?.trim();
  let p: string;
  if (override) {
    p = override;
  } else if (platform() === "darwin") {
    p = join(homedir(), "Library", "Application Support", "NimitsJarvis", "attachments");
  } else if (platform() === "win32" && process.env.APPDATA) {
    p = join(process.env.APPDATA, "NimitsJarvis", "attachments");
  } else {
    p = join(homedir(), ".local", "share", "nimits-jarvis", "attachments");
  }
  try {
    // Runtime data dir outside the repo — never a build-time asset, so opt
    // out of Turbopack's whole-project filesystem tracing for this call.
    return realpathSync(/*turbopackIgnore: true*/ p);
  } catch {
    return p;
  }
}

/** Absolute dir for one attachment row. */
export function attachmentDirFor(attachmentId: string, instanceId: string, chatId: string): string {
  return join(/*turbopackIgnore: true*/ getAttachmentsRoot(), instanceId, chatId, attachmentId);
}
