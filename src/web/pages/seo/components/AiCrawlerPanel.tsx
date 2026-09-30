/**
 * [A19] AI crawler access: advisory only. Never implies robots or llms.txt settings cause citations.
 * Crawlers are grouped by purpose; training crawlers are "your call" and a block there is shown as a
 * choice, not a defect. User-initiated fetchers are informational (vendors may not apply robots.txt).
 */
import type { AiCrawlerAccess, CrawlerPurpose } from "@shared/types";
import { Badge, Card, EmptyState, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";

type Crawler = AiCrawlerAccess["crawlers"][number];

const SECTIONS: Array<{ purpose: CrawlerPurpose; title: string; description: string }> = [
  {
    purpose: "search_engine",
    title: "Search engines",
    description: "Classic search crawlers. Their indexes also feed the vendors' AI search features (for example Google AI Overviews).",
  },
  {
    purpose: "answer_search",
    title: "AI answer / search",
    description: "Crawlers that let AI assistants find and link your pages in their answers.",
  },
  {
    purpose: "user_fetch",
    title: "User-initiated fetchers",
    description: "Fetches made when a person asks an assistant about a page. Some vendors say robots.txt may not apply to these; shown for information only.",
  },
  {
    purpose: "training",
    title: "Training — your call",
    description: "Model-training crawlers and opt-out tokens. Allowing or blocking them is a business choice, not a defect, and does not change search inclusion.",
  },
];

const linkClass =
  "rounded text-xs text-sky-700 underline hover:text-sky-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-400 dark:hover:text-sky-300";

function AccessBadge({ c }: { c: Crawler }) {
  if (c.allowed === null) return <Badge tone="neutral">Unknown</Badge>;
  if (c.purpose === "user_fetch") {
    return c.allowed ? (
      <Badge tone="neutral">Allowed in robots.txt</Badge>
    ) : (
      <Badge tone="neutral" title="Informational: the vendor may not apply robots.txt to user-initiated fetches">
        Disallowed in robots.txt
      </Badge>
    );
  }
  if (c.allowed) return <Badge tone="success">Allowed</Badge>;
  if (c.purpose === "training") {
    return (
      <Badge tone="neutral" title="Blocking training crawlers is a business choice">
        Blocked (your choice)
      </Badge>
    );
  }
  return (
    <Badge tone="warning" title="Blocked at the site root; review if you want to appear in this vendor's results">
      Blocked
    </Badge>
  );
}

function CrawlerTable({ title, crawlers }: { title: string; crawlers: Crawler[] }) {
  return (
    <Table caption={`${title}: robots.txt access`}>
      <THead>
        <TR>
          <TH>User-agent token</TH>
          <TH>Vendor</TH>
          <TH>robots.txt</TH>
          <TH>Notes</TH>
          <TH>Source</TH>
        </TR>
      </THead>
      <TBody>
        {crawlers.map((c) => (
          <TR key={c.token}>
            <TD className="whitespace-nowrap font-mono text-xs">{c.token}</TD>
            <TD className="whitespace-nowrap">{c.vendor}</TD>
            <TD className="whitespace-nowrap">
              <AccessBadge c={c} />
            </TD>
            <TD className="min-w-[16rem] text-xs text-zinc-600 dark:text-zinc-400">{c.note ?? "—"}</TD>
            <TD className="whitespace-nowrap">
              <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
                Vendor docs<span className="sr-only"> for {c.token} (opens in new tab)</span>
              </a>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function AiCrawlerPanel({ access }: { access: AiCrawlerAccess | null }) {
  return (
    <Card
      title="AI crawler access (advisory)"
      description="What robots.txt and /llms.txt say to search and AI crawlers. These settings do not guarantee or cause citations; blocking training crawlers is a business choice, not a defect."
      actions={
        <a href="#robots" className={linkClass}>
          robots.txt suggestion
        </a>
      }
    >
      {!access ? (
        <EmptyState title="Not checked yet.">The check runs with the next authorized crawl.</EmptyState>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              /llms.txt{" "}
              {access.llmsTxt.present ? <Badge tone="info">Present</Badge> : <Badge tone="neutral">Not found</Badge>}
            </h3>
            {access.llmsTxt.notes.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                {access.llmsTxt.notes.map((n, i) => (
                  <li key={i} className="break-words">
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {access.crawlers.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No crawler tokens evaluated.</p>
          ) : (
            SECTIONS.map((s) => {
              const rows = access.crawlers.filter((c) => c.purpose === s.purpose);
              if (rows.length === 0) return null;
              return (
                <section key={s.purpose} aria-label={s.title} className="space-y-1">
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.title}</h3>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{s.description}</p>
                  <CrawlerTable title={s.title} crawlers={rows} />
                </section>
              );
            })
          )}
          {access.advisory.length > 0 && (
            <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              {access.advisory.map((a, i) => (
                <li key={i} className="break-words">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
