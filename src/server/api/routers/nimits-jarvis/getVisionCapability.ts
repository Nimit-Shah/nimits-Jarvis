import { z } from "zod";
import { protectedProcedure } from "~/server/api/trpc";
import { resolveVisionCapability } from "./agent/model-utils";

const visionCapabilityInput = z.object({
  modelId: z.string().min(1).max(128),
});

/**
 * Vision capability for a model id — data-driven (OpenRouter
 * `architecture.input_modalities`, 1h server cache), `"unknown"` when
 * unverifiable. The composer gates attachment affordances on `false`;
 * `unknown` allows with the provider error surfacing verbatim on failure.
 */
export const getVisionCapability = protectedProcedure
  .input(visionCapabilityInput)
  .query(async ({ input }) => {
    return { capability: await resolveVisionCapability(input.modelId) };
  });
