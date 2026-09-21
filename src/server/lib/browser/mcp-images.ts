import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { db } from "~/server/clients/db";
import { getAttachmentsRoot } from "~/server/lib/attachments/constants";
import { sha256Hex, writeOriginalAndDerivatives } from "~/server/lib/attachments/derive";
import { sniffImageMime } from "~/server/lib/attachments/validate";

/**
 * MCP screenshot ingest — the last mile for browser vision.
 *
 * Playwright screenshot results arrive in two shapes depending on server
 * flags: inline `image` content blocks (with `--caps vision`) or a bare
 * server-side file path (`.playwright-mcp/page-….png`). Neither reaches a
 * vision model on its own: the agent loop only carries text/json tool
 * results. So both shapes are persisted through the SAME ingest as user
 * uploads (magic-byte sniff, derivatives, `MessageAttachment` row) and
 * returned in the SAME shape as `view_image` (dataUrl on the volatile
 * tail). If view_image's pixels are visible to the model, so are these.
 *
 * Exposure class is identical to user-attached images: bytes reach the
 * active (possibly cloud) model. Screenshots are operator-initiated reads
 * of an allowlisted page, not third-party content.
 */

export const MCP_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_PER_RESULT = 3;
const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
};

export type McpImageResult =
  | { imageId: string; mediaType: string; dimensions: string; dataUrl: string }
  | { error: string };

async function persistBytes(args: {
  instanceId: string;
  chatId: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<McpImageResult> {
  const { instanceId, chatId, bytes, mimeType } = args;
  if (bytes.length === 0 || bytes.length > MCP_IMAGE_MAX_BYTES) {
    return { error: `Screenshot is ${bytes.length} bytes; the limit is ${MCP_IMAGE_MAX_BYTES}.` };
  }
  const { mime } = sniffImageMime(bytes);
  if (!mime) return { error: "Screenshot bytes failed image validation." };

  const row = await db.messageAttachment.create({
    data: {
      chatId,
      instanceId,
      kind: "image",
      mimeType: mime,
      origin: "mcp",
      sha256: sha256Hex(bytes),
      bytesOrig: bytes.length,
      bytesSent: 0,
      width: 0,
      height: 0,
      storagePath: "",
      thumbPath: "",
      status: "processing",
    },
    select: { id: true },
  });
  try {
    const derived = await writeOriginalAndDerivatives({ attachmentId: row.id, instanceId, chatId, bytes, mimeType: mime });
    await db.messageAttachment.update({
      where: { id: row.id },
      data: {
        status: "ready",
        storagePath: derived.storagePath,
        thumbPath: derived.thumbPath,
        width: derived.width,
        height: derived.height,
        bytesSent: derived.bytesSent,
      },
    });
    const sent = await readFile(joinRoot(derived.storagePath));
    return {
      imageId: row.id,
      mediaType: "image/webp",
      dimensions: `${derived.width}x${derived.height}`,
      dataUrl: `data:image/webp;base64,${sent.toString("base64")}`,
    };
  } catch (err) {
    await db.messageAttachment
      .update({ where: { id: row.id }, data: { status: "error", error: String(err).slice(0, 500) } })
      .catch(() => undefined);
    return { error: "Screenshot could not be processed." };
  }
}

function joinRoot(storagePath: string): string {
  // storagePath is server-generated (relative); never operator input.
  return resolve(getAttachmentsRoot(), storagePath);
}

/**
 * Resolve a `.playwright-mcp/*.png`-style reference from tool text to bytes.
 * The MCP server may run anywhere; only same-machine files under the daemon
 * working directory are reachable. Anything else is an explicit miss (never
 * an ambiguous path the model tries to open).
 */
async function readScreenshotFile(ref: string): Promise<Buffer | null> {
  const clean = ref.trim().replace(/^\(|\)$/g, "");
  const abs = clean.startsWith("/") ? clean : resolve(process.cwd(), clean);
  const ext = extname(abs).toLowerCase();
  if (!SCREENSHOT_EXTS.has(ext)) return null;
  const cwd = resolve(process.cwd()) + sep;
  if (!abs.startsWith(cwd)) return null;
  try {
    const buf = await readFile(abs);
    return buf.length > 0 && buf.length <= MCP_IMAGE_MAX_BYTES ? buf : null;
  } catch {
    return null;
  }
}

const SCREENSHOT_PATH_RE = /\(?((?:\.?\.?\/)?\.playwright-mcp\/[^\s)]+\.(?:png|jpe?g|webp))\)?/gi;

/**
 * Extract up to MAX_IMAGES_PER_RESULT screenshots from MCP tool content:
 * inline image blocks first, then server-side file references in text.
 * Returns persisted results in order; text without pixels is left alone.
 */
export async function ingestMcpScreenshots(args: {
  instanceId: string;
  chatId: string;
  blocks: McpContentBlock[];
}): Promise<McpImageResult[]> {
  const { instanceId, chatId, blocks } = args;
  const out: McpImageResult[] = [];

  for (const b of blocks) {
    if (out.length >= MAX_IMAGES_PER_RESULT) break;
    if (b.type === "image" && b.data) {
      const bytes = Buffer.from(b.data, "base64");
      out.push(await persistBytes({ instanceId, chatId, bytes, mimeType: b.mimeType ?? "image/png" }));
    }
  }
  if (out.length === 0) {
    const text = blocks.map((b) => b.text ?? "").join("\n");
    const seen = new Set<string>();
    for (const m of text.matchAll(SCREENSHOT_PATH_RE)) {
      if (out.length >= MAX_IMAGES_PER_RESULT) break;
      const ref = m[1];
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const buf = await readScreenshotFile(ref);
      if (buf) out.push(await persistBytes({ instanceId, chatId, bytes: buf, mimeType: "image/png" }));
    }
  }
  return out;
}
