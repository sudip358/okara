/**
 * Backlink monitor building blocks shared by the Backlinks page and the Live Backlinks containers: status chip,
 * change badge, compact URL cell and the history timeline (check history, redirect chain, events). Untrusted strings
 * (URLs, anchors, rel values, robots values, sheet cells) are React text only; links use ExternalUrl (http(s) only,
 * rel="noopener noreferrer nofollow").
 */
import type { BacklinkCheckView, BacklinkDetail, BacklinkEventView, BacklinkStatus } from "@shared/backlinks";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { cx } from "@web/components/ui";
import { formatDateTime } from "@web/lib/format";
import { METHOD_LABEL, TONE_CLASS, anchorMatchText, relLabel, statusChip, targetText, urlParts } from "./lib";

export function StatusChip({ status, httpStatus, className }: { status: BacklinkStatus | null; httpStatus?: number | null; className?: string }) {
  const c = statusChip(status, httpStatus ?? null);
  return (
    <span data-status={status ?? "unchecked"} className={cx("inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset", TONE_CLASS[c.tone], className)}>
      {c.label}
    </span>
  );
}

/** "checked in browser": the status comes from Cloudflare's headless browser (Browser Run), not the plain fetch. */
export function BrowserBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="browser-badge"
      title="This result comes from a re-check in Cloudflare's headless browser (Browser Run): the plain fetch saw no link, a bot wall or a failure."
      className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap ring-1 ring-inset", TONE_CLASS.neutral, className)}
    >
      checked in browser
    </span>
  );
}

export function ChangeBadge({ text, negative, at }: { text: string | null; negative: boolean | null; at?: string | null }) {
  if (!text) return null;
  return (
    <span
      title={at ? `${text} (${formatDateTime(at)})` : text}
      className={cx("inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset", negative ? TONE_CLASS.bad : TONE_CLASS.neutral)}
    >
      <span aria-hidden="true" className="mr-1">
        {negative ? "▼" : "●"}
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

/** Host on the first line, path muted on the second (full URL in the tooltip). */
export function UrlCell({ url }: { url: string }) {
  const p = urlParts(url);
  return (
    <span className="block min-w-0" title={url}>
      <span className="block truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{p.host}</span>
      <span className="block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.path}</span>
    </span>
  );
}

function ChainList({ check }: { check: BacklinkCheckView }) {
  if (check.redirectChain.length === 0) return null;
  return (
    <ol className="mt-1 space-y-0.5 text-xs" aria-label="Redirect chain">
      {check.redirectChain.map((h, i) => (
        <li key={`${i}:${h.to}`} className="flex min-w-0 gap-1.5">
          <span className="shrink-0 font-mono text-zinc-500 dark:text-zinc-400">{h.status} →</span>
          <span className="min-w-0 break-all">{h.to}</span>
        </li>
      ))}
    </ol>
  );
}

export function EventLine({ e }: { e: BacklinkEventView }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm" data-event={e.kind}>
      <span className={cx("font-medium", e.negative ? "text-rose-700 dark:text-rose-300" : "text-zinc-800 dark:text-zinc-200")}>
        <span aria-hidden="true">{e.negative ? "▼ " : "● "}</span>
        {e.message}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatDateTime(e.detectedAt)}</span>
    </li>
  );
}

/** Drawer body: latest facts, redirect chain, events and the check history (newest first). */
export function BacklinkHistory({ detail }: { detail: BacklinkDetail }) {
  const b = detail.backlink;
  const latest = detail.checks[0] ?? null;
  const target = targetText(b);
  return (
    <div className="space-y-4" data-testid="backlink-history">
      <dl className="space-y-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Live URL</dt>
          <dd className="min-w-0">
            <ExternalUrl url={b.liveUrl} />
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Target</dt>
          <dd className="min-w-0">
            <ExternalUrl url={b.targetUrl} /> <span className={cx("text-xs", target.broken ? "text-rose-700 dark:text-rose-300" : "text-zinc-500 dark:text-zinc-400")}>({target.text})</span>
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Status</dt>
          <dd className="min-w-0">
            <StatusChip status={b.status} httpStatus={b.httpStatus} /> {b.checkMethod === "browser" && <BrowserBadge />}{" "}
            {b.status === "redirected" && b.linkRel && <span className="text-xs">final page: {relLabel(b.linkRel)}</span>}
          </dd>
        </div>
        {b.statusReason && <p className="text-xs text-zinc-600 dark:text-zinc-400">{b.statusReason}</p>}
        {(b.browserState === "pending" || b.browserReason) && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="browser-reason">
            {b.browserState === "pending" ? "Waiting for a re-check in the headless browser (Browser Run)." : b.browserReason}
          </p>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Anchor</dt>
          <dd className="min-w-0 break-words">
            expected “{b.anchorExpected ?? "—"}” · found “{b.anchorFound ?? "—"}”{anchorMatchText(b) ? ` · ${anchorMatchText(b)}` : ""}
          </dd>
        </div>
        {b.relText && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-zinc-600 dark:text-zinc-400">rel</dt>
            <dd className="font-mono text-xs">{b.relText}</dd>
          </div>
        )}
        {(b.vendor || b.linkType || b.placedDate || b.priceText || b.da !== null || b.traffic !== null) && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            From your sheet: {[b.vendor, b.linkType, b.placedDate, b.da !== null ? `DA ${b.da}` : null, b.traffic !== null ? `traffic ${b.traffic.toLocaleString("en-US")}` : null, b.priceText].filter(Boolean).join(" · ")}
          </p>
        )}
      </dl>
      {latest && latest.redirectChain.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">Redirect chain (latest check)</h3>
          <ChainList check={latest} />
        </section>
      )}
      {latest && (latest.metaRobots || latest.xRobotsTag || latest.canonicalUrl) && (
        <section className="space-y-0.5 text-xs">
          <h3 className="text-sm font-semibold">Page signals (latest check)</h3>
          {latest.metaRobots && <p>meta robots: {latest.metaRobots}</p>}
          {latest.xRobotsTag && <p>X-Robots-Tag: {latest.xRobotsTag}</p>}
          {latest.canonicalUrl && <p className="break-all">canonical points to {latest.canonicalUrl}</p>}
        </section>
      )}
      <section>
        <h3 className="text-sm font-semibold">Changes</h3>
        {detail.events.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">No changes between checks yet (the first check is the baseline).</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {detail.events.map((e) => (
              <EventLine key={e.id} e={e} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="text-sm font-semibold">Check history (latest {detail.checks.length})</h3>
        {detail.checks.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Not checked yet.</p>
        ) : (
          <ol className="mt-1 space-y-2 border-l border-zinc-200 pl-3 dark:border-zinc-700">
            {detail.checks.map((c) => (
              <li key={c.id} className="min-w-0 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500 dark:text-zinc-400">{formatDateTime(c.checkedAt)}</span>
                  <span data-method={c.method} className="rounded bg-zinc-100 px-1 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {METHOD_LABEL[c.method]}
                  </span>
                  <StatusChip status={c.status} httpStatus={c.httpStatus} />
                  {c.httpStatus !== null && <span className="font-mono">HTTP {c.httpStatus}</span>}
                  {c.targetStatus !== null && <span className="font-mono">target {c.targetStatus}</span>}
                  {c.robots && <span>robots: {c.robots}</span>}
                </div>
                {c.statusReason && <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">{c.statusReason}</p>}
                {c.anchorFound && <p className="mt-0.5 break-words">anchor “{c.anchorFound}”{c.relText ? ` · rel ${c.relText}` : ""}</p>}
                <ChainList check={c} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
