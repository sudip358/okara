/** [A19] AI crawler access: advisory only. Never implies robots or llms.txt settings cause citations. */
import type { AiCrawlerAccess } from "@shared/types";
import { Badge, Card, EmptyState, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";

export function AiCrawlerPanel({ access }: { access: AiCrawlerAccess | null }) {
  return (
    <Card
      title="AI crawler access (advisory)"
      description="What robots.txt and /llms.txt say to AI crawlers. These settings do not guarantee or cause citations; blocking training crawlers is a business choice, not a defect."
    >
      {!access ? (
        <EmptyState title="Not checked yet.">The check runs with the next authorized crawl.</EmptyState>
      ) : (
        <div className="space-y-4">
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
            <Table caption="AI crawler robots.txt access">
              <THead>
                <TR>
                  <TH>User-agent token</TH>
                  <TH>Vendor</TH>
                  <TH>Purpose</TH>
                  <TH>robots.txt</TH>
                  <TH>Source</TH>
                </TR>
              </THead>
              <TBody>
                {access.crawlers.map((c) => (
                  <TR key={c.token}>
                    <TD className="font-mono text-xs">{c.token}</TD>
                    <TD>{c.vendor}</TD>
                    <TD className="whitespace-nowrap">{c.purpose === "answer_search" ? "Answer / search" : "Training"}</TD>
                    <TD className="whitespace-nowrap">
                      {c.allowed === null ? (
                        <Badge tone="neutral">Unknown</Badge>
                      ) : c.allowed ? (
                        <Badge tone="success">Allowed</Badge>
                      ) : c.purpose === "training" ? (
                        <Badge tone="neutral" title="Blocking training crawlers is a business choice">
                          Blocked (choice)
                        </Badge>
                      ) : (
                        <Badge tone="warning" title="Answer/search crawler blocked; review if you want to be cited by this vendor">
                          Blocked
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      <a
                        href={c.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="rounded text-xs text-sky-700 underline hover:text-sky-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
                      >
                        Vendor docs<span className="sr-only"> for {c.token} (opens in new tab)</span>
                      </a>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
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
