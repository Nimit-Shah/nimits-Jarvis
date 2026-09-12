import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db } from "~/server/clients/db";

export const skillSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "slug must be lowercase [a-z0-9-]");

/** Ownership gate — skills are user-scoped, so a slug can never cross users. */
export async function getOwnedSkill(userId: string, slug: string) {
  const row = await db.skill.findUnique({
    where: { userId_slug: { userId, slug } },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No skill named "${slug}".` });
  }
  return row;
}
