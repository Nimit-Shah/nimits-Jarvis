/**
 * Magic-byte validation for image uploads. Never trust extension or the
 * client's MIME type — the canonical mimeType comes from these signatures.
 */

export const SUPPORTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

const SVG_SIGNS = ["<svg", "<?xml"];

export function sniffImageMime(buf: Buffer): { mime?: SupportedImageMime; rejectedAs?: string } {
  if (buf.length < 12) return { rejectedAs: "too small to identify" };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg" };
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: "image/webp" };
  }
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mime: "image/gif" };
  }
  // TIFF: II*\0 or MM\0*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return { mime: "image/tiff" };
  }
  // HEIC/HEIF: ftyp box at offset 4 (heic, heix, hevc, hevx, heim, heis, hevm, hevs, mif1, msf1)
  const ftyp = buf.subarray(4, 12).toString("ascii");
  if (ftyp.startsWith("ftyp")) {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(brand)) {
      return { mime: "image/heic" };
    }
    if (["mif1", "msf1"].includes(brand)) {
      return { mime: "image/heif" };
    }
  }
  // SVG: text-based, script-execution vector — dedicated reject
  const head = buf.subarray(0, 256).toString("utf8").trimStart().slice(0, 5).toLowerCase();
  if (SVG_SIGNS.some((s) => buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase().startsWith(s)) || head === "<svg") {
    return { rejectedAs: "svg" };
  }
  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { rejectedAs: "pdf" };
  }
  return { rejectedAs: "unknown" };
}

export function rejectionMessage(rejectedAs: string): string {
  if (rejectedAs === "svg") {
    return "SVG images are not supported (they can contain scripts). Export as PNG instead.";
  }
  return "PNG, JPEG, WebP, GIF, HEIC and TIFF are supported.";
}
