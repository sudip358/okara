/** Small shared pieces of the internal-links workbench. Untrusted text (titles, anchors, sentences) renders as plain text. */
import type { LinkGraphSummary, LinkVerificationView } from "@shared/types";
import { formatDateTime } from "@web/lib/format";
import { Badge, cx } from "@web/components/ui";
import { coverageLines, safeHref, shortUrl, VERIFICATION_TONE } from "./lib";

/** The user's own crawled URL as an external link (http/https only), shown as its path. */
export function UrlText({ url, className }: { url: string; className?: string }) {
  const href = safeHref(url);
  const text = shortUrl(url);
  if (!href) return <span className={className}>{text}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={url} className={cx("break-all text-sky-700 underline-offset-2 hover:underline dark:text-sky-400", className)}>
      {text}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function VerificationBadge({ v }: { v: LinkVerificationView | null | undefined }) {
  if (!v) return null;
  return (
    <Badge tone={VERIFICATION_TONE[v.status]} title={v.detail ?? undefined}>
      {v.label}
    </Badge>
  );
}

/** Coverage line shown above every tab: "N of M sitemap URLs analysed (oldest snapshot …)", stale and rolling context. */
export function CoverageStrip({ graph, className }: { graph: LinkGraphSummary | null | undefined; className?: string }) {
  const lines = coverageLines(graph);
  if (!graph) return null;
  return (
    <div role="note" aria-label="Link graph coverage" className={cx("rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300", className)}>
      {lines.length ? (
        <p>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">Coverage:</span> {lines.join(" · ")}
          {graph.builtAt ? <span className="text-zinc-500 dark:text-zinc-400"> · graph built {formatDateTime(graph.builtAt)}</span> : null}
        </p>
      ) : (
        <p>{graph.labels[0] ?? "No link graph yet."}</p>
      )}
      {graph.newerCrawl ? <p className="mt-1 text-amber-800 dark:text-amber-300">A newer crawl exists; rebuild the graph to include it.</p> : null}
    </div>
  );
}

export function YesNo({ ok, yes = "Yes", no = "No" }: { ok: boolean; yes?: string; no?: string }) {
  return ok ? (
    <span className="text-emerald-700 dark:text-emerald-400">
      <span aria-hidden="true">✓ </span>
      {yes}
    </span>
  ) : (
    <span className="text-red-700 dark:text-red-400">
      <span aria-hidden="true">✗ </span>
      {no}
    </span>
  );
}

/** A "How this works" disclosure with plain-text notes. */
export function MethodNotes({ notes, title = "How this works" }: { notes: readonly string[]; title?: string }) {
  if (!notes.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">{title}</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">
        {notes.map((n, i) => (
          <li key={i} className="break-words">
            {n}
          </li>
        ))}
      </ul>
    </details>
  );
}
