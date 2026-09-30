/**
 * [A21] Checklist rendering shared by the project checklists (SEO | GEO) and the per-page checklist.
 * All item text (summaries, evidence, URLs) is rendered as plain text; evidence URLs are plain links with
 * rel="noopener noreferrer nofollow" and only for http(s) URLs.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import type { Checklist, ChecklistItem, ChecklistKind, ChecklistSection, ChecklistStatus } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { formatDateTime, formatNumber } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, Button, Card, CompletenessNote, cx, inputClass, type BadgeTone } from "@web/components/ui";

export const SECTION_LABEL: Record<ChecklistSection, string> = {
  technical: "Technical",
  on_page: "On-page",
  quick_wins: "Quick wins",
  seo_content: "Content",
  links: "Links",
  access: "Access",
  content: "Content",
  structure: "Structure",
  mentions: "Mentions",
  trust: "Trust",
  tracking: "Tracking",
  before_write: "Before you write",
  while_write: "While you write",
  details: "The details",
  publish_check: "Publish and check",
};

const SECTION_NOTE: Partial<Record<ChecklistSection, string>> = {
  quick_wins: "Opportunities measured from your own Search Console data where connected.",
  links: "Backlink data is not connected; AI-cited sources are shown where they help.",
  access: "Measured from the latest crawl of your verified site.",
  mentions: "Sources AI answers already cite for your prompts. Manual-action lists: the app never posts, reviews, or contacts anyone for you.",
  tracking: "API-sampled measurements; consumer-app answers only enter as labelled manual imports.",
  before_write: "Planning checks: intent and coverage from GSC queries and Jev judgments where available.",
  publish_check: "Measured from this page's latest snapshot and the crawl it belongs to.",
};

export const SECTION_ORDER: Record<ChecklistKind, ChecklistSection[]> = {
  seo: ["technical", "on_page", "quick_wins", "seo_content", "links"],
  geo: ["access", "content", "structure", "mentions", "trust", "tracking"],
  page: ["before_write", "while_write", "details", "publish_check"],
};

export const STATUS_META: Record<ChecklistStatus, { label: string; tone: BadgeTone; symbol: string }> = {
  met: { label: "Met", tone: "success", symbol: "✓" },
  not_met: { label: "Not met", tone: "danger", symbol: "✕" },
  partial: { label: "Partial", tone: "warning", symbol: "◐" },
  manual: { label: "Manual", tone: "info", symbol: "☐" },
  not_connected: { label: "Not connected", tone: "neutral", symbol: "–" },
  not_applicable: { label: "Not applicable", tone: "neutral", symbol: "–" },
  unknown: { label: "Unknown", tone: "neutral", symbol: "?" },
};

const STATUS_ORDER: ChecklistStatus[] = ["not_met", "partial", "manual", "unknown", "not_connected", "met", "not_applicable"];
const METHOD_LABEL: Record<ChecklistItem["method"], string> = { measured: "Measured", heuristic: "Heuristic", manual: "Manual" };
const METHOD_HINT: Record<ChecklistItem["method"], string> = {
  measured: "Computed from stored crawl, Search Console, or GEO data.",
  heuristic: "Estimated with a labelled rule of thumb (or a model judgment); check it yourself.",
  manual: "Cannot be measured here; you confirm it.",
};
export const TIER_HINT =
  "Reference tier from Okara's \"SEO tactics, ranked by impact\" graphic (S highest to D lowest). It is an external opinion used only to order items within a section: not a measured impact, and it never affects recommendation priority. Where your data disagrees, the data wins.";

export function StatusBadge({ item }: { item: Pick<ChecklistItem, "status" | "manual"> }) {
  const m = STATUS_META[item.status];
  if (item.status === "manual" && item.manual?.checked) {
    return (
      <Badge tone="success" title="Confirmed manually">
        <span aria-hidden="true">✓</span> Done (manual)
      </Badge>
    );
  }
  return (
    <Badge tone={m.tone}>
      <span aria-hidden="true">{m.symbol}</span> {m.label}
    </Badge>
  );
}

export function StatusCounts({ counts, label }: { counts: Checklist["counts"]; label: string }) {
  const order: ChecklistStatus[] = ["met", "not_met", "partial", "manual", "not_connected", "not_applicable", "unknown"];
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {order.map((s) => (
        <li key={s}>
          <Badge tone={counts[s] > 0 ? STATUS_META[s].tone : "neutral"} className={counts[s] === 0 ? "opacity-60" : undefined}>
            <span className="tabular-nums">{formatNumber(counts[s])}</span> {STATUS_META[s].label.toLowerCase()}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const tierRank = (t: ChecklistItem["tacticTier"]) => (t ? "SABCD".indexOf(t) : 5);

/** Within a section: reference tier (SEO) then status; page items keep their numbered order. */
export function orderItems(kind: ChecklistKind, items: ChecklistItem[]): ChecklistItem[] {
  if (kind === "page") return items;
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => tierRank(a.item.tacticTier) - tierRank(b.item.tacticTier) || STATUS_ORDER.indexOf(a.item.status) - STATUS_ORDER.indexOf(b.item.status) || a.i - b.i)
    .map((x) => x.item);
}

export interface ChecklistViewProps {
  checklist: Checklist;
  projectId: string;
  /** API path for PUT, given an item id (without the /api prefix). */
  putPath: (itemId: string) => string;
  onItemSaved: (item: ChecklistItem) => void;
}

export function ChecklistView({ checklist, projectId, putPath, onItemSaved }: ChecklistViewProps) {
  const [attentionOnly, setAttentionOnly] = useState(false);
  const filterId = useId();
  const kind = checklist.kind;
  const numbering = new Map(checklist.items.map((i, n) => [i.id, n + 1]));
  const visible = (i: ChecklistItem) => !attentionOnly || !(i.status === "met" || i.status === "not_applicable" || (i.status === "manual" && i.manual?.checked));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusCounts counts={checklist.counts} label={`${kind.toUpperCase()} checklist status counts`} />
        <label htmlFor={filterId} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input id={filterId} type="checkbox" className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
          Only items needing attention
        </label>
      </div>
      {SECTION_ORDER[kind].map((section) => {
        const items = orderItems(
          kind,
          checklist.items.filter((i) => i.section === section),
        ).filter(visible);
        const all = checklist.items.filter((i) => i.section === section);
        if (all.length === 0) return null;
        const met = all.filter((i) => i.status === "met" || (i.status === "manual" && i.manual?.checked)).length;
        return (
          <Card key={section} title={SECTION_LABEL[section]} description={SECTION_NOTE[section]} actions={<span className="text-xs text-zinc-600 dark:text-zinc-400">{met} of {all.length} done</span>} bodyClassName="p-0">
            {items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">Nothing needs attention in this section.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {items.map((i) => (
                  <li key={i.id}>
                    <ChecklistItemRow item={i} kind={kind} number={kind === "page" ? numbering.get(i.id) ?? null : null} projectId={projectId} putPath={putPath} onSaved={onItemSaved} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

export function ChecklistItemRow({
  item,
  kind,
  number,
  projectId,
  putPath,
  onSaved,
}: {
  item: ChecklistItem;
  kind: ChecklistKind;
  number: number | null;
  projectId: string;
  putPath: (itemId: string) => string;
  onSaved: (item: ChecklistItem) => void;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="shrink-0 pt-0.5">
          <StatusBadge item={item} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {number !== null && <span className="mr-1.5 tabular-nums text-zinc-500 dark:text-zinc-400">{String(number).padStart(2, "0")}</span>}
            {item.label}
          </h3>
          <p className="mt-0.5 break-words text-sm text-zinc-700 dark:text-zinc-300">{item.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral" title={METHOD_HINT[item.method]}>
            {METHOD_LABEL[item.method]}
          </Badge>
          {kind === "seo" && item.tacticTier && (
            <Badge tone="info" title={TIER_HINT}>
              Tier {item.tacticTier} <span className="font-normal">(external opinion)</span>
            </Badge>
          )}
        </div>
      </div>

      <details className="group mt-2">
        <summary
          className="inline-flex cursor-pointer select-none items-center gap-1 rounded text-xs font-medium text-sky-800 hover:underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-300"
        >
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
          Evidence, guidance{item.caveat ? ", caveats" : ""}
          {item.evidence.length > 0 && ` (${item.evidence.length})`}
        </summary>
        <div className="mt-2 space-y-3 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
          {item.evidence.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Evidence</h4>
              <ul className="mt-1 space-y-1.5">
                {item.evidence.map((e, n) => {
                  const href = safeHttpUrl(e.url);
                  return (
                    <li key={n} className="text-sm">
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">{e.label}</span>
                      {e.url &&
                        (href ? (
                          <>
                            {" "}
                            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-sky-800 underline dark:text-sky-300">
                              {e.url}
                            </a>
                          </>
                        ) : (
                          <span className="break-all text-zinc-700 dark:text-zinc-300"> {e.url}</span>
                        ))}
                      {e.detail && <p className="break-words text-xs text-zinc-600 dark:text-zinc-400">{e.detail}</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">What to do</h4>
            <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{item.guidance}</p>
          </div>
          {item.caveat && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Caveat</h4>
              <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">{item.caveat}</p>
            </div>
          )}
          <CompletenessNote completeness={item.completeness} />
          {item.links.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              {item.links.map((l) => (
                <li key={`${l.to}-${l.label}`}>
                  <Link to={l.to ? projectPath(projectId, l.to) : projectPath(projectId)} className="text-sky-800 underline dark:text-sky-300">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {item.manual && item.status === "manual" && <ManualControl item={item} putPath={putPath} onSaved={onSaved} />}
    </div>
  );
}

function ManualControl({ item, putPath, onSaved }: { item: ChecklistItem; putPath: (itemId: string) => string; onSaved: (item: ChecklistItem) => void }) {
  const m = item.manual!;
  const [checked, setChecked] = useState(m.checked);
  const [note, setNote] = useState(m.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = useId();
  const dirty = checked !== m.checked || note.trim() !== (m.note ?? "");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api<ChecklistItem>(putPath(item.id), { method: "PUT", body: { checked, note: note.trim() ? note.trim() : null } });
      onSaved(updated);
      setChecked(updated.manual?.checked ?? checked);
      setNote(updated.manual?.note ?? "");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${base}-done`} className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          <input id={`${base}-done`} type="checkbox" className="h-4 w-4 accent-emerald-700" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Mark as done
        </label>
        {m.updatedAt && (
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            Last updated {formatDateTime(m.updatedAt)}
            {m.updatedBy ? ` by ${m.updatedBy}` : ""}
          </span>
        )}
      </div>
      <label htmlFor={`${base}-note`} className="mt-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Note (optional, what you checked and where)
      </label>
      <textarea
        id={`${base}-note`}
        className={cx(inputClass, "mt-1 min-h-14 text-sm")}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-describedby={`${base}-count`}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span id={`${base}-count`} className="text-xs text-zinc-500 dark:text-zinc-400">
          {note.length}/500
        </span>
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!dirty}>
          Save
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

/** Replace one item in a checklist (status/counts unchanged: manual items stay "manual"). */
export function withItem(c: Checklist, item: ChecklistItem): Checklist {
  return { ...c, items: c.items.map((i) => (i.id === item.id ? item : i)) };
}

export function SourcesLine({ checklist }: { checklist: Checklist }) {
  const s = checklist.sources;
  const parts = [
    s.crawledAt ? `Crawl ${formatDateTime(s.crawledAt)}` : "No crawl",
    s.gscSyncedAt ? `Search Console sync ${formatDateTime(s.gscSyncedAt)}` : "No Search Console data",
    checklist.kind === "page" ? `${formatNumber(s.geoObservations)} GEO answers cite this page` : `${formatNumber(s.geoObservations)} GEO observations`,
    `Generated ${formatDateTime(checklist.generatedAt)}`,
    `Version ${checklist.checklistVersion}`,
  ];
  return <p className="text-xs text-zinc-600 dark:text-zinc-400">{parts.join(" · ")}</p>;
}

export function Disclaimer({ text }: { text: string }) {
  return (
    <div role="note" aria-label="Disclaimer" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      {text}
    </div>
  );
}
