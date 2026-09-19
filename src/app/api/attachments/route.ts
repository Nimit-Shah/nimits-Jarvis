import { rm } from "node:fs/promises";
import { auth } from "~/server/auth";
import { db } from "~/server/clients/db";
import { attachmentDirFor } from "~/server/lib/attachments/constants";
import { sha256Hex, writeOriginalAndDerivatives } from "~/server/lib/attachments/derive";
import { rejectionMessage, sniffImageMime } from "~/server/lib/attachments/validate";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ORIGINS = new Set(["paste", "picker", "fs_read", "composio", "tool"]);

/**
 * POST /api/attachments — multipart FormData { file: Blob, chatId: string,
 * origin?: string }. Validates by magic bytes, writes archival original +
 * sent/thumb derivatives, creates a composer-stage row (messageId null).
 * Never returns filesystem paths.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;

  // Best-effort orphan sweep (debounced 6h, bounded per pass).
  void import("~/server/lib/attachments/gc").then((m) => m.sweepAttachments());

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form with a file." }, { status: 400 });
  }
  const file = form.get("file");
  const chatIdRaw = form.get("chatId");
  const originRaw = form.get("origin");
  if (!(file instanceof Blob)) {
    return Response.json({ error: "Missing file." }, { status: 400 });
  }
  let chatId = typeof chatIdRaw === "string" && chatIdRaw ? chatIdRaw : null;
  const origin = typeof originRaw === "string" && ORIGINS.has(originRaw) ? originRaw : "picker";

  // Lazy thread creation (mirrors chat route): pasting into an unsaved New
  // Chat creates the thread on first attachment, never before.
  if (!chatId) {
    const { getInstanceForUser } = await import("~/server/api/routers/nimits-jarvis/utils");
    const instance = await getInstanceForUser(userId);
    const created = await db.chat.create({
      data: { instanceId: instance.id, name: "New Chat", model: instance.anthropicModel },
      select: { id: true, instanceId: true },
    });
    chatId = created.id;
  }

  const chat = await db.chat.findFirst({
    where: { id: chatId, instance: { userId } },
    select: { id: true, instanceId: true },
  });
  if (!chat) return Response.json({ error: "Not found." }, { status: 404 });

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    return Response.json({ error: "Empty file." }, { status: 400 });
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File is too large." }, { status: 400 });
  }

  const { mime, rejectedAs } = sniffImageMime(bytes);
  if (!mime) {
    return Response.json({ error: rejectionMessage(rejectedAs ?? "unknown") }, { status: 415 });
  }

  const sha256 = sha256Hex(bytes);
  // Per-message rows (no chat-level unique): reuse derivative bytes when the
  // same image already exists ready in this chat, but keep a distinct row so
  // messageId/summary stay per-use.
  const prior = await db.messageAttachment.findFirst({
    where: { chatId: chat.id, sha256, status: "ready" },
    select: { storagePath: true, thumbPath: true, width: true, height: true, bytesSent: true, mimeType: true },
  });

  const row = await db.messageAttachment.create({
    data: {
      chatId: chat.id,
      instanceId: chat.instanceId,
      kind: "image",
      mimeType: mime,
      origin,
      sha256,
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
    if (prior) {
      const { copyFile } = await import("node:fs/promises");
      const { getAttachmentsRoot } = await import("~/server/lib/attachments/constants");
      const { join, dirname } = await import("node:path");
      const path = await import("node:path");
      const root = getAttachmentsRoot();
      const dir = attachmentDirFor(row.id, chat.instanceId, chat.id);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      const sentDest = join(dir, "sent.webp");
      const thumbDest = join(dir, "thumb.webp");
      const origDest = join(dir, `original.${mime.split("/")[1]}`);
      await copyFile(join(root, prior.storagePath), sentDest).catch(() => undefined);
      await copyFile(join(root, prior.thumbPath), thumbDest).catch(() => undefined);
      await import("node:fs/promises").then((fs) => fs.writeFile(origDest, bytes));
      const storagePath = path.relative(root, sentDest);
      const thumbPath = path.relative(root, thumbDest);
      await db.messageAttachment.update({
        where: { id: row.id },
        data: {
          status: "ready",
          storagePath,
          thumbPath,
          width: prior.width,
          height: prior.height,
          bytesSent: prior.bytesSent,
        },
      });
      void dirname;
      return Response.json({
        id: row.id,
        chatId: chat.id,
        thumbUrl: `/api/attachments/${row.id}?variant=thumb`,
        width: prior.width,
        height: prior.height,
        status: "ready",
      });
    }

    const derived = await writeOriginalAndDerivatives({
      attachmentId: row.id,
      instanceId: chat.instanceId,
      chatId: chat.id,
      bytes,
      mimeType: mime,
    });
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
    return Response.json({
      id: row.id,
      chatId: chat.id,
      thumbUrl: `/api/attachments/${row.id}?variant=thumb`,
      width: derived.width,
      height: derived.height,
      status: "ready",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Couldn't read this image — it may be incomplete.";
    await db.messageAttachment.update({
      where: { id: row.id },
      data: { status: "error", error: reason.slice(0, 500) },
    }).catch(() => undefined);
    await rm(attachmentDirFor(row.id, chat.instanceId, chat.id), { recursive: true, force: true }).catch(() => undefined);
    const status = reason.includes("limit is") ? 413 : 422;
    return Response.json({ error: reason, id: row.id }, { status });
  }
}
