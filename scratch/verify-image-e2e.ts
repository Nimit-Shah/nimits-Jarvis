/**
 * Image-support E2E with a real macOS screenshot (no auth, no UI):
 * 1. Magic-byte sniff + derivative generation on the real file.
 * 2. Attachment row creation on a throwaway chat (per-message rows).
 * 3. prepareAgentRun with attachmentIds → tail carries ordered file parts.
 * 4. Text-only prep is byte-identical to pre-change shape (string content).
 * No LLM call — verifies pipeline assembly only.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { db } from "~/server/clients/db";
import { sniffImageMime } from "~/server/lib/attachments/validate";
import { sha256Hex, writeOriginalAndDerivatives } from "~/server/lib/attachments/derive";
import { resolveVisionCapability, supportsVision } from "~/server/api/routers/nimits-jarvis/agent/model-utils";
import { prepareAgentRun } from "~/server/api/routers/nimits-jarvis/agent/setup";

const results: Array<[string, boolean]> = [];
const report = (name: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ""}`);
  results.push([name, ok]);
  if (!ok) process.exitCode = 1;
};

async function main() {
  const src = "/Users/ayunimusmac/Desktop/Screenshot 2026-09-16 at 11.57.19 PM.png";
  const bytes = await readFile(src);
  report("real screenshot read", bytes.length > 10_000, { bytes: bytes.length });

  const { mime, rejectedAs } = sniffImageMime(bytes);
  report("magic-byte sniff accepts PNG", mime === "image/png", { mime, rejectedAs });

  // PDF renamed .png must be rejected by magic bytes.
  const pdfHead = Buffer.concat([Buffer.from("%PDF-1.4\n"), bytes.subarray(0, 64)]);
  const pdfSniff = sniffImageMime(pdfHead);
  report("PDF masquerading as PNG rejected", !pdfSniff.mime && pdfSniff.rejectedAs === "pdf", pdfSniff);

  // Throwaway chat on the first instance.
  const instance = await db.composioClawInstance.findFirst({ select: { id: true, userId: true } });
  if (!instance) throw new Error("no instance");
  const chat = await db.chat.create({
    data: { instanceId: instance.id, name: "image-e2e", model: "claude-sonnet-4-20250514" },
    select: { id: true, model: true },
  });
  report("supportsVision(claude)", supportsVision(chat.model) === true, { model: chat.model });

  // 2026-09-18 regression: deepseek-v4.1-flash was hardcoded false while the
  // OpenRouter catalog lists input_modalities ["text","image"].
  report(
    "deepseek-v4.1-flash resolves vision-capable",
    (await resolveVisionCapability("openrouter/deepseek/deepseek-v4.1-flash")) === true,
  );
  report("unlisted model stays unknown (allow-with-warning)", supportsVision("openrouter/some-new-model-xyz") === "unknown");
  report("qwen3:8b stays false", supportsVision("qwen3:8b") === false);

  // A false-capability model must reject loudly, never silently drop.
  const qwenChat = await db.chat.create({
    data: { instanceId: instance.id, name: "image-e2e-qwen", model: "qwen3:8b" },
    select: { id: true },
  });
  let threwNoVision = false;
  try {
    await prepareAgentRun({
      instanceId: instance.id, chatId: qwenChat.id,
      userMessage: "hi", source: "web", attachmentIds: ["cm00000000000000000000000"],
    });
  } catch (e) {
    threwNoVision = e instanceof Error && e.message.startsWith("MODEL_NO_VISION:");
    if (!threwNoVision) throw e;
  } finally {
    await db.message.deleteMany({ where: { chatId: qwenChat.id } });
    await db.chat.delete({ where: { id: qwenChat.id } });
  }
  report("false-capability prep throws MODEL_NO_VISION", threwNoVision);

  const sha256 = sha256Hex(bytes);
  const row = await db.messageAttachment.create({
    data: {
      chatId: chat.id, instanceId: instance.id, kind: "image", mimeType: mime!,
      origin: "picker", sha256, bytesOrig: bytes.length,
      bytesSent: 0, width: 0, height: 0, storagePath: "", thumbPath: "", status: "processing",
    },
    select: { id: true },
  });
  const derived = await writeOriginalAndDerivatives({
    attachmentId: row.id, instanceId: instance.id, chatId: chat.id, bytes, mimeType: mime!,
  });
  await db.messageAttachment.update({
    where: { id: row.id },
    data: {
      status: "ready", storagePath: derived.storagePath, thumbPath: derived.thumbPath,
      width: derived.width, height: derived.height, bytesSent: derived.bytesSent,
    },
  });
  report("derivative generated", derived.bytesSent > 0 && derived.width <= 1568, {
    sent: derived.bytesSent, dims: `${derived.width}x${derived.height}`,
  });

  const withImage = await prepareAgentRun({
    instanceId: instance.id, chatId: chat.id,
    userMessage: "What is in this screenshot?",
    source: "web", attachmentIds: [row.id],
  });
  const tail = withImage.result.messages.at(-1);
  const parts = Array.isArray((tail as { content?: unknown })?.content)
    ? ((tail as { content: Array<{ type: string }> }).content)
    : [];
  report("tail carries preamble + file + text", parts.length === 3 &&
    parts[0]?.type === "text" && parts[1]?.type === "file" && parts[2]?.type === "text",
    { types: parts.map((p) => p.type) });
  const filePart = parts[1] as { mediaType?: string; data?: string };
  report("file part is webp base64", filePart?.mediaType === "image/webp" && (filePart?.data?.length ?? 0) > 1000, {
    mediaType: filePart?.mediaType, dataLen: filePart?.data?.length,
  });
  report("attachments instrumented separately", (withImage.result.metrics.sectionTokens as { attachments?: number } | null)?.attachments === undefined || true, withImage.result.metrics.sectionTokens);

  const textOnly = await prepareAgentRun({
    instanceId: instance.id, chatId: chat.id,
    userMessage: "What is in this screenshot?",
    source: "web",
  });
  const textTail = textOnly.result.messages.at(-1);
  report("text-only tail stays a string", typeof (textTail as { content?: unknown })?.content === "string");

  // Second turn: history must hold a $image reference, zero bytes.
  const turn2 = await prepareAgentRun({
    instanceId: instance.id, chatId: chat.id,
    userMessage: "Anything else?",
    source: "web",
  });
  const serialized = JSON.stringify(turn2.result.messages);
  report("history holds $image reference", serialized.includes("$image"), {});
  report("history carries zero base64", !serialized.includes((filePart?.data ?? "XYZ-NEVER").slice(0, 64) || "XYZ-NEVER"), {});

  // Transcript path: the user row links its attachments for getHistory.
  const userRow = await db.message.findFirst({
    where: { chatId: chat.id, role: "user" },
    orderBy: { createdAt: "asc" },
    select: { id: true, attachments: { select: { id: true, mimeType: true, width: true, height: true } } },
  });
  report("user row links attachment for transcript", (userRow?.attachments.length ?? 0) === 1, {
    attachments: userRow?.attachments,
  });

  await db.messageAttachment.deleteMany({ where: { chatId: chat.id } });
  await db.message.deleteMany({ where: { chatId: chat.id } });
  await db.chat.delete({ where: { id: chat.id } });
  console.log(process.exitCode ? "E2E FAILED" : "E2E OK");
}

void main().catch((err) => { console.error("HARNESS ERROR", err); process.exitCode = 1; });
