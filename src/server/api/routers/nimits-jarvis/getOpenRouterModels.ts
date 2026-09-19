import { protectedProcedure } from "~/server/api/trpc";
import { env } from "~/env";

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
  };
}

export const getOpenRouterModels = protectedProcedure.query(async () => {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    // Cache for 1 hour
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter models: ${response.statusText}`);
  }

  const data = await response.json() as { data: OpenRouterModel[] };
  
  // Sort alphabetically by name
  return data.data.sort((a, b) => a.name.localeCompare(b.name));
});
