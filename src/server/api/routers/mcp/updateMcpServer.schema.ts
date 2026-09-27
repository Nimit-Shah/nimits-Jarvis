import { z } from "zod";

export const updateMcpServerSchema = z.object({
  serverId: z.string().cuid(),
  label: z.string().min(1).max(60).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  // Browser policy (serverType playwright; policy fields bump policyVersion).
  originMode: z.enum(["open", "allowlist"]).optional(),
  serverType: z.enum(["generic", "playwright"]).optional(),
  browserMode: z.enum(["bundled", "channel", "executable", "cdp", "extension"]).optional(),
  browserChannel: z.string().max(40).nullable().optional(),
  executablePath: z.string().max(300).nullable().optional(),
  userDataDir: z.string().max(300).nullable().optional(),
  cdpEndpoint: z.string().max(200).nullable().optional(),
  cdpConfirmed: z.boolean().optional(),
  // Typed consent: must equal "ATTACH" verbatim; sets cdpConfirmed.
  cdpConfirmPhrase: z.string().max(20).optional(),
  // CDP ceiling — set outside the Browser tab (row overflow menu).
  cdpAllowed: z.boolean().optional(),
  extensionConfirmed: z.boolean().optional(),
  headless: z.boolean().optional(),
  noSandbox: z.boolean().optional(),
  infraSeedEnabled: z.boolean().optional(),
  infraSeedExcluded: z.array(z.string().max(120)).max(64).optional(),
  // Dismiss the browser-type proposal banner. Deliberately outside the
  // policy-keys list: no daemon impact, no version bump.
  dismissTypeConfirmation: z.boolean().optional(),
});

export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;
