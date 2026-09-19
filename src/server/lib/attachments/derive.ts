import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import sharp from "sharp";
import { attachmentDirFor, getAttachmentsRoot } from "./constants";

/** Decompression-bomb ceiling — enforced via header metadata before decode. */
export const MAX_IMAGE_EDGE_PX = 12_000;
/** Derivative policy: longest edge ≤1568px, downscale-only, WebP q88. */
export const SENT_LONG_EDGE_PX = 1568;
export const THUMB_LONG_EDGE_PX = 256;

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
};

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function extForMime(mime: string): string {
  return EXT_FOR_MIME[mime] ?? "bin";
}

export interface DerivativeResult {
  dir: string;
  originalFile: string;
  sentFile: string;
  thumbFile: string;
  storagePath: string;
  thumbPath: string;
  width: number;
  height: number;
  bytesSent: number;
}

/**
 * Write the archival original untouched, then derive sent.webp (what travels)
 * and thumb.webp. sharp.metadata() reads the header before pixel decode, so
 * the dimension ceiling is enforced without a memory spike. No withMetadata()
 * call — derivatives carry no EXIF/XMP; the original retains them on disk.
 */
export async function writeOriginalAndDerivatives(args: {
  attachmentId: string;
  instanceId: string;
  chatId: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<DerivativeResult> {
  const { attachmentId, instanceId, chatId, bytes, mimeType } = args;
  const dir = attachmentDirFor(attachmentId, instanceId, chatId);
  await mkdir(dir, { recursive: true });

  const originalFile = join(dir, `original.${extForMime(mimeType)}`);
  await writeFile(originalFile, bytes);

  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width > MAX_IMAGE_EDGE_PX || height > MAX_IMAGE_EDGE_PX) {
    throw new Error(
      `Image is ${width}x${height}; the limit is ${MAX_IMAGE_EDGE_PX} on either edge.`,
    );
  }

  const sentFile = join(dir, "sent.webp");
  const sentInfo = await sharp(bytes)
    .rotate()
    .resize({
      width: SENT_LONG_EDGE_PX,
      height: SENT_LONG_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .webp({ quality: 88 })
    .toFile(sentFile);

  const thumbFile = join(dir, "thumb.webp");
  await sharp(bytes)
    .rotate()
    .resize({
      width: THUMB_LONG_EDGE_PX,
      height: THUMB_LONG_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toFile(thumbFile);

  const root = getAttachmentsRoot();
  return {
    dir,
    originalFile,
    sentFile,
    thumbFile,
    storagePath: relative(root, sentFile),
    thumbPath: relative(root, thumbFile),
    width: sentInfo.width,
    height: sentInfo.height,
    bytesSent: sentInfo.size,
  };
}
