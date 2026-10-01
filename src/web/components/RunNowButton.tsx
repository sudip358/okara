/** "Run now" for an agent: POST /projects/:pid/runs {agent}. Surfaces quota / setup errors; opens the Activity window for the started run. OWNED BY: web-shell. */
import type { AgentKind, RunSummary } from "@shared/types";
import { api, errorMessage, isRateLimited, isSetupRequired } from "@web/lib/api";
import { useMutation } from "@web/lib/hooks";
import { agentLabel } from "@web/lib/format";
import { Button, type ButtonSize } from "./ui";
import { openActivity } from "./activity/bus";

export function RunNowButton({
  projectId,
  agent,
  onStarted,
  size = "sm",
  disabled,
}: {
  projectId: string;
  agent: AgentKind;
  onStarted?: (run: RunSummary) => void;
  size?: ButtonSize;
  disabled?: boolean;
}) {
  const m = useMutation(() => api<RunSummary>(`/projects/${encodeURIComponent(projectId)}/runs`, { method: "POST", body: { agent } }));
  const err = m.error;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        size={size}
        loading={m.loading}
        disabled={disabled}
        onClick={async (e) => {
          const opener = e.currentTarget;
          const run = await m.run();
          if (run) {
            onStarted?.(run);
            openActivity({ projectId, runId: run.id, opener });
          }
        }}
      >
        Run {agentLabel(agent)} now
      </Button>
      <span aria-live="polite" className="text-xs">
        {m.data && <span className="text-zinc-600 dark:text-zinc-400">Run queued ({m.data.status}).</span>}
        {err !== null && (
          <span className={isRateLimited(err) || isSetupRequired(err) ? "text-amber-800 dark:text-amber-300" : "text-red-700 dark:text-red-400"}>
            {isRateLimited(err) ? "Quota reached: " : isSetupRequired(err) ? "Setup required: " : ""}
            {errorMessage(err)}
          </span>
        )}
      </span>
    </div>
  );
}
