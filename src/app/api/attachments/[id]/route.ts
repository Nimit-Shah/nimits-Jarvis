import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { auth } from "~/server/auth";
import { db } from "~/server/clients/db";
import { getAttachmentsRoot } from "~/server/lib/attachments/constants";

/**
 * GET /api/attachments/[id]?variant=thumb|sent — ownership-checked byte
 * serving. 404 (not 403) on miss so existence isn't confirmed. Never exposes
 * filesystem paths.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "Not found." }, { status: 404 });

  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") === "sent" ? "sent" : "thumb";

  const row = await db.messageAttachment.findFirst({
    where: { id, chat: { instance: { userId } } },
    select: { storagePath: true, thumbPath: true, mimeType: true, status: true },
  });
  if (!row || row.status !== "ready") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const rel = variant === "sent" ? row.storagePath : row.thumbPath;
  if (!rel) return Response.json({ error: "Not found." }, { status: 404 });
  const abs = join(getAttachmentsRoot(), rel);
  // Containment: resolved path must stay under the attachments root.
  if (!abs.startsWith(getAttachmentsRoot())) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const stream = createReadStream(abs);
  const webStream = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
  return new Response(webStream, {
    headers: {
      "Content-Type": variant === "thumb" || variant === "sent" ? "image/webp" : row.mimeType,
      "Content-Length": String(size),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** DELETE /api/attachments/[id] — mark removed; GC sweeps bytes after 24h. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const { id } = await ctx.params;
  const row = await db.messageAttachment.findFirst({
    where: { id, chat: { instance: { userId } } },
    select: { id: true },
  });
  if (!row) return Response.json({ error: "Not found." }, { status: 404 });
  await db.messageAttachment.update({
    where: { id },
    data: { status: "removed" },
  });
  return Response.json({ ok: true });
}
