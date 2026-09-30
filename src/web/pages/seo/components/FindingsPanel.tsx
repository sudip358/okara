/** Audit findings grouped by area and severity. Counts are real rows from the audit; no composite score. */
import { useMemo, useState } from "react";
import type { AuditFinding, Severity } from "@shared/types";
import { Badge, Card, CompletenessNote, EmptyState, type BadgeTone } from "@web/components/ui";
import type { Completeness } from "@shared/types";
import { SEVERITY_ORDER, countBySeverity, groupFindings } from "../lib";

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: "danger",
  major: "warning",
  moderate: "info",
  minor: "neutral",
  advisory: "neutral",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  major: "Major",
  moderate: "Moderate",
  minor: "Minor",
  advisory: "Advisory",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function ClassBadge({ cls }: { cls: AuditFinding["class"] }) {
  return cls === "fact" ? (
    <Badge tone="info" title="Directly observed in crawled HTML or HTTP response">
      Fact
    </Badge>
  ) : (
    <Badge tone="neutral" title="Configurable heuristic; applicability depends on context">
      Heuristic
    </Badge>
  );
}

export function FindingsPanel({ findings, completeness }: { findings: AuditFinding[]; completeness: Completeness }) {
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const counts = useMemo(() => countBySeverity(findings), [findings]);
  const filtered = useMemo(() => (severity === "all" ? findings : findings.filter((f) => f.severity === severity)), [findings, severity]);
  const groups = useMemo(() => groupFindings(filtered), [filtered]);

  return (
    <Card
      title="Findings"
      description="Grouped by area, then severity. Rule class shows whether a finding is an observed fact or a heuristic."
    >
      <CompletenessNote completeness={completeness} className="mb-3" />
      <div role="group" aria-label="Filter by severity" className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip active={severity === "all"} onClick={() => setSeverity("all")}>
          All ({findings.length})
        </FilterChip>
        {SEVERITY_ORDER.map((s) => (
          <FilterChip key={s} active={severity === s} onClick={() => setSeverity(s)} disabled={counts[s] === 0}>
            {SEVERITY_LABEL[s]} ({counts[s]})
          </FilterChip>
        ))}
      </div>
      {groups.length === 0 ? (
        <EmptyState title={findings.length === 0 ? "No findings in the checked coverage." : "No findings at this severity."}>
          {findings.length === 0 && "This only covers the pages crawled; it is not proof the whole site has no issues."}
        </EmptyState>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.area} aria-label={`${g.area} findings`}>
              <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {g.area} <span className="font-normal text-zinc-500 dark:text-zinc-400">({g.total})</span>
              </h3>
              <div className="space-y-3">
                {g.bySeverity.map((sg) => (
                  <ul key={sg.severity} className="space-y-2">
                    {sg.findings.map((f) => (
                      <FindingRow key={f.id} f={f} />
                    ))}
                  </ul>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function FindingRow({ f }: { f: AuditFinding }) {
  return (
    <li className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={f.severity} />
        <ClassBadge cls={f.class} />
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{f.ruleName}</span>
        <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{f.ruleId}</span>
      </div>
      <p className="mt-1 break-all text-xs text-zinc-600 dark:text-zinc-400">
        {f.template ? (
          <>
            <span className="font-medium">Template:</span> {f.template}
            {f.url ? ` · e.g. ${f.url}` : ""}
          </>
        ) : f.url ? (
          <>
            <span className="font-medium">URL:</span> {f.url}
          </>
        ) : (
          "Site-wide"
        )}
      </p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">{f.detail}</p>
      {f.applicability && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Applicability:</span> {f.applicability}
        </p>
      )}
    </li>
  );
}

function FilterChip({
  active,
  children,
  onClick,
  disabled,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed disabled:opacity-40 dark:focus-visible:outline-sky-400 " +
        (active
          ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-100"
          : "bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800")
      }
    >
      {children}
    </button>
  );
}
