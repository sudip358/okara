import type { AuditFinding, BuyerQueryRow, CoverageResponse, PageType, Severity } from "@shared/types";

export const SEVERITY_ORDER: Severity[] = ["critical", "major", "moderate", "minor", "advisory"];

export const PAGE_TYPES: PageType[] = ["home", "collection", "product", "article", "landing", "other"];

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  home: "Home",
  collection: "Collection / category",
  product: "Product",
  article: "Article",
  landing: "Landing",
  other: "Other",
};

export interface FindingGroup {
  area: string;
  bySeverity: Array<{ severity: Severity; findings: AuditFinding[] }>;
  total: number;
}

/** Group findings by area, then severity (most severe first). Areas sorted by worst severity then name. */
export function groupFindings(findings: AuditFinding[]): FindingGroup[] {
  const byArea = new Map<string, AuditFinding[]>();
  for (const f of findings) {
    const list = byArea.get(f.area) ?? [];
    list.push(f);
    byArea.set(f.area, list);
  }
  const groups: FindingGroup[] = [];
  for (const [area, list] of byArea) {
    const bySeverity = SEVERITY_ORDER.map((severity) => ({
      severity,
      findings: list.filter((f) => f.severity === severity).sort((a, b) => a.ruleName.localeCompare(b.ruleName)),
    })).filter((g) => g.findings.length > 0);
    groups.push({ area, bySeverity, total: list.length });
  }
  const worst = (g: FindingGroup) => SEVERITY_ORDER.indexOf(g.bySeverity[0]?.severity ?? "advisory");
  groups.sort((a, b) => worst(a) - worst(b) || a.area.localeCompare(b.area));
  return groups;
}

export function countBySeverity(findings: AuditFinding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, major: 0, moderate: 0, minor: 0, advisory: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

// ------------------------------------------------------------------ buyer queries
/** "Classified N of M" from completeness; null when the counts are unknown. Pure. */
export function buyerProgress(d: Pick<CoverageResponse<BuyerQueryRow>, "completeness"> | null | undefined): { covered: number; total: number; done: boolean; label: string } | null {
  const c = d?.completeness;
  if (!c || c.covered === null || c.total === null) return null;
  const covered = Math.min(c.covered, c.total);
  return { covered, total: c.total, done: covered >= c.total, label: `Classified ${covered.toLocaleString("en-US")} of ${c.total.toLocaleString("en-US")} non-brand queries` };
}
