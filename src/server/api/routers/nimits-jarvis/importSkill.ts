import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "~/server/api/trpc";
import {
  cleanupTmp,
  cloneRepo,
  finalizeStagedSkill,
  findSkillSubdir,
  isGitUrl,
  stageRawSkill,
  ImportError,
} from "~/server/lib/skills/import-pipeline";
import { importSkillInput } from "./importSkill.schema";

/**
 * Import from a URL or git repo. Everything installed this way lands
 * untrusted — "curated" would describe a list, never a trust level. Findings
 * are returned and stored so the operator reviews before promoting.
 * Shares its pipeline with install_skill (Phase 8): one code path to audit.
 */
export const importSkill = protectedProcedure
  .input(importSkillInput)
  .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const mapError = (err: unknown): TRPCError =>
      err instanceof ImportError
        ? new TRPCError({ code: err.code, message: err.message })
        : new TRPCError({ code: "BAD_REQUEST", message: "Fetch failed." });

    if (isGitUrl(input.url)) {
      let tmpBase: string | null = null;
      try {
        const cloned = await cloneRepo(input.url);
        tmpBase = cloned.tmpBase;
        const stagedDir = await findSkillSubdir(tmpBase, { subdir: input.subdir });
        return await finalizeStagedSkill({
          userId,
          stagedDir,
          sourceRepo: input.url,
          sourceRef: cloned.sourceRef,
          slugOverride: input.slug,
        });
      } catch (err) {
        throw mapError(err);
      } finally {
        await cleanupTmp(tmpBase);
      }
    }

    let tmpBase: string | null = null;
    try {
      const res = await fetch(input.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Fetch failed: HTTP ${res.status}.` });
      }
      tmpBase = await stageRawSkill(await res.text());
      return await finalizeStagedSkill({
        userId,
        stagedDir: tmpBase,
        sourceRepo: input.url,
        slugOverride: input.slug,
      });
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      throw mapError(err);
    } finally {
      await cleanupTmp(tmpBase);
    }
  });
