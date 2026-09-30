/**
 * [A21] Checklist registry: versions, disclaimer, ordering, and assembly of ChecklistItem[] from item
 * definitions + manual answers. Reference tiers order items within a section only; they never enter
 * recommendation priority.
 */
import type { CapabilityState, Checklist, ChecklistItem, ChecklistKind, ChecklistSection, ChecklistStatus } from "@shared/types";
import type { ItemDef, TacticTier } from "./items/common";
import { MAX_EVIDENCE } from "./items/common";
import { GEO_ITEMS } from "./items/geo";
import { PAGE_ITEMS } from "./items/page";
import { SEO_ITEMS } from "./items/seo";

/** Bump when an item's id, wording, method, or threshold changes. */
export const CHECKLIST_VERSION = "checklists-2026-09-30.1";

export const DISCLAIMER = "These are practices that make pages easier to crawl, understand, and cite. None guarantees rankings, inclusion, or citation.";

export const SECTION_ORDER: Record<ChecklistKind, ChecklistSection[]> = {
  seo: ["technical", "on_page", "quick_wins", "seo_content", "links"],
  geo: ["access", "content", "structure", "mentions", "trust", "tracking"],
  page: ["before_write", "while_write", "details", "publish_check"],
};

export const ALL_STATUSES: readonly ChecklistStatus[] = ["met", "not_met", "partial", "manual", "not_connected", "not_applicable", "unknown"];

const TIER_RANK: Record<TacticTier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
/** Actionable first: failing, partial, then items awaiting a person, unknown, not connected, met, not applicable. */
const STATUS_RANK: Record<ChecklistStatus, number> = { not_met: 0, partial: 1, manual: 2, unknown: 3, not_connected: 4, met: 5, not_applicable: 6 };

export const ITEMS_BY_KIND = { seo: SEO_ITEMS, geo: GEO_ITEMS, page: PAGE_ITEMS } as const;

export function itemDef(kind: ChecklistKind, id: string): ItemDef<never> | undefined {
  return (ITEMS_BY_KIND[kind] as readonly ItemDef<never>[]).find((d) => d.id === id);
}

export interface ManualState {
  checked: boolean;
  note: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Evaluate one definition into a contract ChecklistItem (manual state merged for manual items). */
export function evaluateItem<C>(def: ItemDef<C>, ctx: C, manual: ManualState | undefined, kind: ChecklistKind): ChecklistItem {
  const r = def.evaluate(ctx);
  const isManual = r.method === "manual" && r.status === "manual";
  return {
    id: def.id,
    section: def.section,
    label: def.label,
    status: r.status,
    method: r.method,
    summary: r.summary,
    evidence: (r.evidence ?? []).slice(0, MAX_EVIDENCE),
    completeness: r.completeness ?? null,
    guidance: r.guidance,
    caveat: r.caveat ?? null,
    links: r.links ?? [],
    manual: isManual ? (manual ?? { checked: false, note: null, updatedAt: null, updatedBy: null }) : null,
    tacticTier: kind === "seo" ? def.tier : null,
  };
}

/** Section order, then (SEO) reference tier, then status; registry order breaks ties. Page items keep their numbered order. */
export function sortItems(kind: ChecklistKind, items: ChecklistItem[]): ChecklistItem[] {
  const sections = SECTION_ORDER[kind];
  const indexed = items.map((item, i) => ({ item, i }));
  indexed.sort((a, b) => {
    const s = sections.indexOf(a.item.section) - sections.indexOf(b.item.section);
    if (s !== 0 || kind === "page") return s || a.i - b.i;
    const ta = a.item.tacticTier ? TIER_RANK[a.item.tacticTier] : 5;
    const tb = b.item.tacticTier ? TIER_RANK[b.item.tacticTier] : 5;
    return ta - tb || STATUS_RANK[a.item.status] - STATUS_RANK[b.item.status] || a.i - b.i;
  });
  return indexed.map((x) => x.item);
}

export function countStatuses(items: ChecklistItem[]): Record<ChecklistStatus, number> {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ChecklistStatus, number>;
  for (const i of items) counts[i.status]++;
  return counts;
}

export function assembleChecklist<C>(input: {
  kind: ChecklistKind;
  defs: readonly ItemDef<C>[];
  ctx: C;
  manual: Map<string, ManualState>;
  state: CapabilityState;
  now: Date;
  sources: Checklist["sources"];
  page?: Checklist["page"];
}): Checklist {
  const items = sortItems(
    input.kind,
    input.defs.map((d) => evaluateItem(d, input.ctx, input.manual.get(d.id), input.kind)),
  );
  const out: Checklist = {
    kind: input.kind,
    state: input.state,
    checklistVersion: CHECKLIST_VERSION,
    generatedAt: input.now.toISOString(),
    sources: input.sources,
    counts: countStatuses(items),
    items,
    disclaimer: DISCLAIMER,
  };
  if (input.kind === "page") out.page = input.page ?? null;
  return out;
}
