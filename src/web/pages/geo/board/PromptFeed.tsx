/** A · Prompt feed (design §3). Latest cohort, not a live ticker. All prompt text is plain text. */
import type { EngineFeedItem, EngineLaneSummary } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { Badge, cx } from "@web/components/ui";
import { SENTIMENT_LABEL, sourceTypeLabel } from "../lib";
import { FEED_STATUS, LABELS, engineName, feedItems, formatLatency, positionLabel } from "./lib";

export function FeedCard({ item, onOpen }: { item: EngineFeedItem; onOpen?: (observationId: string, title: string) => void }) {
  const st = FEED_STATUS[item.status];
  const latency = formatLatency(item.latencyMs);
  const pos = positionLabel(item.position);
  const canOpen = item.observationId !== null && onOpen !== undefined;
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={st.tone}>{st.label}</Badge>
        {latency && <span className="text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">{latency}</span>}
        {!item.grounded && item.status !== "not_run" && <span className="text-[11px] text-zinc-600 dark:text-zinc-400">Not grounded</span>}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-sm text-zinc-900 dark:text-zinc-100" title={item.promptText}>
        {item.promptText}
      </p>
      <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        {pos && (
          <div>
            <dt className="sr-only">Position</dt>
            <dd>{pos}</dd>
          </div>
        )}
        {item.sentiment && (
          <div title={`Method: ${item.sentiment.method}`}>
            <dt className="inline">Sentiment </dt>
            <dd className="inline">{SENTIMENT_LABEL[item.sentiment.value] ?? item.sentiment.value}</dd>
          </div>
        )}
        {item.citedInstead && (
          <div className="min-w-0 basis-full">
            <dt className="inline">Cited instead: </dt>
            <dd className="inline wrap-anywhere">
              {item.citedInstead.host} via {sourceTypeLabel(item.citedInstead.sourceType)}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
  const cls = cx(
    "block w-full min-w-0 rounded-lg border border-zinc-200 bg-white p-2.5 text-left dark:border-zinc-800 dark:bg-zinc-900",
    canOpen && "hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-600 dark:hover:border-zinc-600",
  );
  return canOpen ? (
    <button type="button" className={cls} onClick={() => onOpen!(item.observationId!, item.promptText)} aria-label={`${st.label}: ${item.promptText}. Open the raw answer`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function PromptFeed({
  lane,
  layout,
  onOpen,
}: {
  lane: EngineLaneSummary;
  /** "row": horizontal scroller inside the lane (desktop); "list": vertical list (mobile). */
  layout: "row" | "list";
  onOpen?: (observationId: string, title: string) => void;
}) {
  const items = feedItems(lane.feed);
  const name = engineName(lane.provider);
  return (
    <section aria-label={`Prompts answered by ${name}`} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          <span aria-hidden="true" className="mr-1 font-mono text-zinc-500 dark:text-zinc-400">A</span>
          {formatNumber(lane.counts.valid)} prompts answered by {name}
        </h4>
        <span className="text-[11px] text-zinc-600 dark:text-zinc-400" title={LABELS.apiSampledTip}>
          Latest cohort · {LABELS.apiSampled}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">No prompt results in the latest cohort.</p>
      ) : (
        <ul
          role="list"
          tabIndex={layout === "row" ? 0 : undefined}
          aria-label={`Latest answers from ${name}`}
          className={
            layout === "row"
              ? "flex snap-x gap-2 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-sky-600 [&>li]:w-56 [&>li]:shrink-0 [&>li]:snap-start"
              : "space-y-2"
          }
        >
          {items.map((it) => (
            <li key={it.promptId} className="min-w-0">
              <FeedCard item={it} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
