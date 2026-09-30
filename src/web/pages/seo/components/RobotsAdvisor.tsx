/**
 * [A19] robots.txt advisor. Shows the site's current robots.txt next to a suggested version that gives
 * search and AI answer crawlers named groups while copying the "*" rules into each (RFC 9309: a crawler
 * with its own group ignores "*"). Suggestion for review only; Okara never edits robots.txt.
 * All robots.txt content is untrusted text and is rendered as plain text only.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CrawlerPurpose, RobotsSuggestion } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { Badge, Button, Card, ErrorState, LoadingState, StateBadge, StateBanner, TBody, TD, TH, THead, TR, Table, type BadgeTone } from "@web/components/ui";

type Change = RobotsSuggestion["changes"][number];

const PURPOSE_LABEL: Record<CrawlerPurpose, string> = {
  search_engine: "Search engine",
  answer_search: "AI answer / search",
  user_fetch: "User-initiated fetcher",
  training: "Training (your call)",
};

const BEFORE: Record<Change["before"], { label: string; tone: BadgeTone }> = {
  allowed: { label: "Allowed", tone: "success" },
  partial: { label: "Partial (some paths disallowed)", tone: "neutral" },
  blocked: { label: "Blocked", tone: "warning" },
  no_group: { label: "No rules apply", tone: "neutral" },
};

function afterBadge(c: Change) {
  if (c.after === "unchanged") return <Badge tone="neutral">Unchanged</Badge>;
  if (c.after === "blocked") return <Badge tone="neutral">{c.purpose === "training" ? "Blocked (your choice)" : "Blocked"}</Badge>;
  return <Badge tone="success">Allowed (your path rules kept)</Badge>;
}

const preClass =
  "max-h-96 min-w-0 overflow-auto whitespace-pre rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100";

function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        onClick={() => {
          const done = (msg: string) => {
            setStatus(msg);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setStatus(""), 2500);
          };
          if (!navigator.clipboard) return done("Copy is not available here; select the text instead.");
          navigator.clipboard.writeText(text).then(
            () => done("Copied."),
            () => done("Copy failed; select the text instead."),
          );
        }}
      >
        Copy suggested robots.txt
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-zinc-600 dark:text-zinc-400">
        {status}
      </span>
    </span>
  );
}

function TextBlock({ title, text, empty, action }: { title: string; text: string | null; empty: string; action?: ReactNode }) {
  const headingId = useId();
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        {action}
      </div>
      {text ? (
        <pre className={preClass} aria-labelledby={headingId} tabIndex={0}>
          {text}
        </pre>
      ) : (
        <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{empty}</p>
      )}
    </div>
  );
}

export function RobotsAdvisor({ projectId }: { projectId: string }) {
  const toggleId = useId();
  const [allowTraining, setAllowTraining] = useState(true);
  const path = projectId ? `/projects/${encodeURIComponent(projectId)}/seo/robots-suggestion?allowTraining=${allowTraining}` : null;
  const q = useApi<RobotsSuggestion>(path);
  const d = q.data;

  return (
    <Card
      id="robots"
      className="scroll-mt-4"
      title="robots.txt advisor"
      description="Suggestion for review — Okara never edits your robots.txt."
      actions={d ? <StateBadge state={d.state} /> : undefined}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={toggleId} className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            <input
              id={toggleId}
              type="checkbox"
              role="switch"
              aria-checked={allowTraining}
              aria-describedby={`${toggleId}-hint`}
              className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
              checked={allowTraining}
              disabled={q.loading}
              onChange={(e) => setAllowTraining(e.target.checked)}
            />
            Allow training crawlers
          </label>
          <p id={`${toggleId}-hint`} className="max-w-3xl text-xs text-zinc-600 dark:text-zinc-400">
            Your call. Allowing training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot) lets models learn about your brand and
            products; blocking them keeps your content out of those training sets. Neither choice affects inclusion in search results. Search engines and AI
            answer/search crawlers are allowed either way.
          </p>
        </div>

        {q.loading && !d ? (
          <LoadingState label="Reading robots.txt…" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.reload} title="robots.txt suggestion unavailable" />
        ) : d ? (
          <AdvisorBody d={d} />
        ) : null}
      </div>
    </Card>
  );
}

function AdvisorBody({ d }: { d: RobotsSuggestion }) {
  return (
    <div className="space-y-4">
      {d.state === "setup_required" && <StateBanner state="setup_required" message={d.notes[d.notes.length - 1] ?? "Verify site ownership first."} />}
      {d.state === "demo" && <StateBanner state="demo" message="Demo data - simulated run. This robots.txt is illustrative and was not fetched from a live site." />}
      {d.state === "error" && <StateBanner state="error" message={d.warnings[0] ?? "robots.txt could not be read."} />}

      {d.warnings.length > 0 && (
        <div role="note" aria-label="Warnings" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Read before you change anything</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {d.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.changes.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Changes by crawler</h3>
          <Table caption="Per-crawler robots.txt changes in the suggestion">
            <THead>
              <TR>
                <TH>User-agent token</TH>
                <TH>Purpose</TH>
                <TH>Now</TH>
                <TH>Suggested</TH>
              </TR>
            </THead>
            <TBody>
              {d.changes.map((c) => (
                <TR key={c.token}>
                  <TD className="whitespace-nowrap font-mono text-xs">{c.token}</TD>
                  <TD className="whitespace-nowrap">{PURPOSE_LABEL[c.purpose] ?? c.purpose}</TD>
                  <TD className="whitespace-nowrap">
                    <Badge tone={BEFORE[c.before].tone}>{BEFORE[c.before].label}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{afterBadge(c)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {(d.currentRobotsTxt !== null || d.suggestedRobotsTxt !== null || d.state === "ready") && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <TextBlock
            title={d.state === "demo" ? "Current robots.txt (demo)" : "Current robots.txt"}
            text={d.currentRobotsTxt}
            empty={d.state === "ready" ? "No robots.txt found on your site." : "Not available."}
          />
          <TextBlock
            title="Suggested robots.txt (for review)"
            text={d.suggestedRobotsTxt}
            empty="No suggestion — see the warnings above."
            action={d.suggestedRobotsTxt ? <CopyButton text={d.suggestedRobotsTxt} /> : undefined}
          />
        </div>
      )}

      {d.preservedRules.length > 0 && (
        <details className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer rounded font-medium text-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-200">
            Rules carried over from your &quot;*&quot; group ({d.preservedRules.length})
          </summary>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
            A crawler that matches a named group ignores the &quot;*&quot; group (RFC 9309), so these rules are repeated in each allowed named group.
          </p>
          <ul className="mt-2 space-y-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
            {d.preservedRules.map((r) => (
              <li key={r} className="break-all">
                {r}
              </li>
            ))}
          </ul>
        </details>
      )}

      {d.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          {d.notes.map((n, i) => (
            <li key={i} className="break-words">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
