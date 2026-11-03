import { z } from "zod";
import { request } from "./http.js";

// Customer /v1/models subset; the admin catalog's legacy capability array is separate.
const CapabilitiesSchema = z.object({
  context_window_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  tool_calls: z.boolean().optional(),
  parallel_tool_calls: z.boolean().optional(),
  vision: z.boolean().optional(),
}).refine(value => value.context_window_tokens === undefined || value.max_output_tokens === undefined || value.max_output_tokens <= value.context_window_tokens)
  .refine(value => value.parallel_tool_calls !== true || value.tool_calls === true);

const CatalogSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({
    id: z.string().min(1),
    display_name: z.string().optional(),
    wire_shapes: z.array(z.string()).optional(),
    capabilities: z.unknown().optional(),
  })),
});

export function parseGatewayModelCapabilities(value: unknown) {
  const catalog = CatalogSchema.safeParse(value);
  if (!catalog.success) throw new Error("Invalid gateway model catalog; raw response omitted.");
  const seen = new Set<string>();
  return catalog.data.data.map(model => {
    if (seen.has(model.id)) throw new Error("Gateway catalog has duplicate model IDs.");
    seen.add(model.id);
    const parsed = CapabilitiesSchema.safeParse(model.capabilities);
    const status = model.capabilities == null ? "unknown" : !parsed.success ? "invalid" : Object.keys(parsed.data).length ? "reported" : "unknown";
    return {
      id: model.id,
      ...(model.display_name ? { display_name: model.display_name } : {}),
      wire_shapes: model.wire_shapes ?? [],
      capability_status: status,
      capabilities: status === "reported" && parsed.success ? parsed.data : null,
    };
  });
}

export async function fetchGatewayModelCapabilities(org: string) {
  const response = await request({ url: "/v1/models", orgId: org, signal: AbortSignal.timeout(10_000) }, z.unknown());
  return parseGatewayModelCapabilities(response.data);
}
