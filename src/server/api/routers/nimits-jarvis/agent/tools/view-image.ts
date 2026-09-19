import { zodSchema } from "ai";
import type { Tool } from "ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "~/server/clients/db";
import { getAttachmentsRoot } from "~/server/lib/attachments/constants";
import { viewImageSchema, type ViewImageInput } from "./view-image.schema";

/**
 * view_image — rehydrate a historical image's bytes into the current turn.
 * Append-only: the derivative returns as a tool result on the volatile tail,
 * never re-inserted at its original history position (cached prefix stays
 * byte-stable). Chat-scoped; never throws.
 */
export function createViewImageTool(
  instanceId: string,
  chatId: string,
): Tool<ViewImageInput, Record<string, unknown>> {
  return {
    description:
      "Reload one chat image's bytes when its $image summary is not enough. Max 3 per turn.",
    inputSchema: zodSchema(viewImageSchema),
    execute: async ({ imageId }) => {
      const row = await db.messageAttachment.findFirst({
        where: { id: imageId, chatId, instanceId, status: "ready" },
        select: { storagePath: true, mimeType: true, width: true, height: true },
      });
      if (!row) {
        return {
          error: {
            code: "NOT_FOUND",
            message: `No image "${imageId}" in this chat. Use an id from a $image reference.`,
          },
        };
      }
      try {
        const buf = await readFile(join(getAttachmentsRoot(), row.storagePath));
        return {
          imageId,
          mediaType: "image/webp",
          dimensions: `${row.width}x${row.height}`,
          // Data URL in a tool result — tail-only, never written to history.
          dataUrl: `data:image/webp;base64,${buf.toString("base64")}`,
        };
      } catch {
        return {
          error: { code: "READ_FAILED", message: `Could not read image "${imageId}".` },
        };
      }
    },
  };
}
