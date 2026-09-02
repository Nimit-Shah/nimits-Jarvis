import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { open, rename, writeFile, stat, chmod } from "node:fs/promises";

/**
 * Atomic write, always. Never writeFile directly onto the target — a crash or
 * full disk mid-write leaves a truncated file, and for source code that is
 * worse than no write at all.
 *
 * Same directory so rename stays on one filesystem (APFS atomic). The caller
 * copies the original into the journal BEFORE calling this, so undo is
 * possible even if the process dies immediately after the rename.
 */
export async function atomicWrite(target: string, content: Buffer | string): Promise<{ bytesWritten: number }> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;

  // Preserve the original file mode when overwriting. Silently changing a
  // script from 0o755 to 0o600 breaks it in a way nobody connects to Jarvis.
  let mode = 0o600;
  try {
    const st = await stat(target);
    mode = st.mode & 0o777;
  } catch {
    // new file — keep 0o600
  }

  const tmp = join(dirname(target), `.jarvis-tmp-${randomUUID()}`);
  await writeFile(tmp, buf, { mode: 0o600 });
  const fh = await open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, mode); // rename carries the mode; set before it lands
  await rename(tmp, target);

  return { bytesWritten: buf.length };
}
