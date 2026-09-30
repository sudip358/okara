/**
 * Writer output schemas. `RECOMMENDATION_V1_JSON_SCHEMA` is verbatim from docs/build-kit.md section 2.3;
 * `recommendationOutputSchema` is the zod equivalent used to validate every parsed writer output.
 * Priority is NOT part of writer output; code computes it.
 *
 * Provider structured-output modes accept only a subset of JSON Schema (no min/max/length
 * constraints, `additionalProperties: false` on every object). `toProviderSchema()` derives that
 * subset; the removed constraints are still enforced client-side by the zod schema.
 */
import { z } from "zod";

export const RECOMMENDATION_V1_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "recommendation.v1",
  type: "object",
  required: ["agent", "scope", "target", "trigger", "issue", "evidence_ids", "action", "rationale", "effort", "uncertainty", "limitations", "verified"],
  additionalProperties: false,
  properties: {
    agent: { enum: ["seo", "geo"] },
    scope: { enum: ["page", "template", "site"] },
    target: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { enum: ["url", "template", "site"] },
        url: { type: "string" },
        template: { type: "string" },
        affected_url_count: { type: "integer", minimum: 0 },
        example_urls: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
    },
    trigger: { type: "string", maxLength: 200 },
    issue: { type: "string", maxLength: 400 },
    evidence_ids: { type: "array", items: { type: "string" }, minItems: 1 },
    evidence_bullets: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        required: ["evidence_id", "source", "text"],
        properties: {
          evidence_id: { type: "string" },
          source: { enum: ["gsc", "crawl", "context_doc", "geo_observation", "manual_import"] },
          text: { type: "string", maxLength: 300 },
        },
      },
    },
    action: { type: "string", maxLength: 600 },
    suggested_snippet: { type: "string", maxLength: 2000 },
    rationale: { type: "string", maxLength: 600 },
    effort: { enum: ["low", "medium", "high"] },
    uncertainty: { enum: ["low", "medium", "high"] },
    limitations: { type: "string", maxLength: 400 },
    confirm_placeholders: { type: "array", items: { type: "string" } },
    verified: { type: "boolean" },
  },
} as const;

export const recommendationOutputSchema = z.strictObject({
  agent: z.enum(["seo", "geo"]),
  scope: z.enum(["page", "template", "site"]),
  target: z.object({
    kind: z.enum(["url", "template", "site"]),
    url: z.string().optional(),
    template: z.string().optional(),
    affected_url_count: z.number().int().min(0).optional(),
    example_urls: z.array(z.string()).max(3).optional(),
  }),
  trigger: z.string().max(200),
  issue: z.string().max(400),
  evidence_ids: z.array(z.string()).min(1),
  evidence_bullets: z
    .array(
      z.object({
        evidence_id: z.string(),
        source: z.enum(["gsc", "crawl", "context_doc", "geo_observation", "manual_import"]),
        text: z.string().max(300),
      }),
    )
    .max(4)
    .optional(),
  action: z.string().max(600),
  suggested_snippet: z.string().max(2000).optional(),
  rationale: z.string().max(600),
  effort: z.enum(["low", "medium", "high"]),
  uncertainty: z.enum(["low", "medium", "high"]),
  limitations: z.string().max(400),
  confirm_placeholders: z.array(z.string()).optional(),
  verified: z.boolean(),
});

export type RecommendationOutput = z.infer<typeof recommendationOutputSchema>;

/** Text fields of a recommendation output that the [A10]/[A17] validator must check. */
export function recommendationTextFields(o: RecommendationOutput): string[] {
  return [
    o.trigger,
    o.issue,
    o.action,
    o.suggested_snippet ?? "",
    o.rationale,
    o.limitations,
    ...(o.evidence_bullets ?? []).map((b) => b.text),
  ].filter((s) => s.length > 0);
}

// ------------------------------------------------------------------ discovery prompt generator
/**
 * The generator prompt asks for a JSON array. Structured-output modes require a top-level object,
 * so the provider schema wraps the array as `{ prompts: [...] }`; the zod parser accepts either.
 */
export const DISCOVERY_PROMPTS_JSON_SCHEMA = {
  type: "object",
  required: ["prompts"],
  additionalProperties: false,
  properties: {
    prompts: {
      type: "array",
      items: {
        type: "object",
        required: ["prompt", "stage", "rationale"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string" },
          stage: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

const discoveryPromptItem = z.object({ prompt: z.string().min(1).max(300), stage: z.string().max(80), rationale: z.string().max(600) });
export const discoveryPromptsOutputSchema = z
  .union([z.array(discoveryPromptItem), z.object({ prompts: z.array(discoveryPromptItem) })])
  .transform((v) => (Array.isArray(v) ? v : v.prompts));

// ------------------------------------------------------------------ provider subset
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
]);

/**
 * Derive the structured-output subset of a JSON schema: drop constraint keywords the providers do
 * not accept and set `additionalProperties: false` on every object. Pure; returns a new object.
 */
export function toProviderSchema(schema: unknown): Record<string, unknown> {
  return strip(schema) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strip(pv)]));
      continue;
    }
    out[k] = strip(v);
  }
  const isObject = out.type === "object" || (out.properties !== undefined && out.type === undefined);
  if (isObject) out.additionalProperties = false;
  return out;
}
