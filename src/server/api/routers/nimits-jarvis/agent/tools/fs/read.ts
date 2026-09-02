import { z } from "zod";
import { zodSchema } from "ai";
import type { Tool } from "ai";
import { open, lstat } from "node:fs/promises";
import { extname } from "node:path";
import { resolveSafePath } from "~/server/lib/fs-access/paths";

export const fsReadSchema = z.object({
  path: z.string().describe("Absolute path or ~/relative path to a file"),
  maxBytes: z.number().int().min(1).max(262_144).default(65_536),
});

export type FsReadInput = z.infer<typeof fsReadSchema>;

type FsToolOptions = { fsReadEnabled: boolean; fsMode: "read-only" | "full"; fsRoot: string | null };

const BINARY_SNIFF_BYTES = 8_192;

export function createFsReadTool(fs: FsToolOptions): Tool<FsReadInput, Record<string, unknown>> {
  return {
    description: "Read a text file on the operator's Mac",
    inputSchema: zodSchema(fsReadSchema),
    execute: async ({ path, maxBytes = 65_536 }) => {
      const resolved = await resolveSafePath(path, fs.fsRoot);
      if (!resolved.ok) {
        return { error: { code: resolved.code, message: resolved.message } };
      }

      let sizeBytes: number;
      try {
        const st = await lstat(resolved.path);
        if (st.isDirectory()) {
          return {
            error: {
              code: "NOT_A_FILE",
              message: "That is a directory — use fs_list.",
            },
          };
        }
        sizeBytes = st.size;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return {
            error: {
              code: "NOT_FOUND",
              message: `No such file or directory: ${path}${path.startsWith("~") ? ` (the ~ was expanded to ${resolved.path})` : ""}`,
            },
          };
        }
        return { error: { code: "BAD_PATH", message: `Filesystem error (${code ?? "unknown"}).` } };
      }

      // Binary sniff BEFORE reading the body — 0x00 in the first 8 KB means
      // never dump it into the context window as mojibake.
      try {
        const fh = await open(resolved.path, "r");
        try {
          const sniff = Buffer.alloc(Math.min(8192, sizeBytes));
          if (sniff.length > 0) {
            await fh.read(sniff, 0, sniff.length, 0);
            if (sniff.includes(0)) {
              return {
                binary: true,
                sizeBytes,
                extension: extname(resolved.path),
                message: "Binary file — content not shown. Use a script (Phase B) to process it.",
              };
            }
          }

          if (sizeBytes <= maxBytes) {
            const buf = Buffer.alloc(sizeBytes);
            await fh.read(buf, 0, sizeBytes, 0);
            return {
              path: resolved.path,
              content: buf.toString("utf-8"),
              sizeBytes,
              truncated: false,
              bytesReturned: sizeBytes,
            };
          }

          // Head/tail excerpt: 70% from start, 30% from end — better for
          // logs and CSVs than a prefix-only read.
          const headLen = Math.floor(maxBytes * 0.7);
          const tailLen = maxBytes - headLen;
          const skipped = sizeBytes - maxBytes;
          const head = Buffer.alloc(headLen);
          const tail = Buffer.alloc(tailLen);
          await fh.read(head, 0, headLen, 0);
          await fh.read(tail, 0, tailLen, sizeBytes - tailLen);
          return {
            path: resolved.path,
            content: `${head.toString("utf-8")}\n… [truncated ${skipped} bytes] …\n${tail.toString("utf-8")}`,
            sizeBytes,
            truncated: true,
            bytesReturned: maxBytes,
          };
        } finally {
          await fh.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM") {
          return {
            error: {
              code: "TCC_BLOCKED",
              message:
                "macOS privacy settings blocked this path. Grant Full Disk Access to the app running Jarvis in System Settings > Privacy & Security, then restart it.",
            },
          };
        }
        return { error: { code: "BAD_PATH", message: `Read failed (${code ?? "unknown"}).` } };
      }
    },
  };
}
