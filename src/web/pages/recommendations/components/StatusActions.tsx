import type { RecommendationStatus } from "@shared/types";
import { Button } from "@web/components/ui";

/** Approve / Dismiss / Mark implemented / Reopen. Approval never claims the site changed. */
export function StatusActions({
  status,
  onStatus,
  busy,
}: {
  status: RecommendationStatus;
  onStatus: (s: RecommendationStatus) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status actions">
      {status !== "approved" && status !== "implemented" && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onStatus("approved")} title="Approve for manual implementation. Nothing is published.">
          Approve
        </Button>
      )}
      {status !== "dismissed" && status !== "implemented" && (
        <Button size="sm" disabled={busy} onClick={() => onStatus("dismissed")}>
          Dismiss
        </Button>
      )}
      {status !== "implemented" && status !== "dismissed" && (
        <Button size="sm" disabled={busy} onClick={() => onStatus("implemented")} title="Records that you made this change yourself. Okara does not publish.">
          Mark implemented
        </Button>
      )}
      {status !== "open" && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStatus("open")}>
          Reopen
        </Button>
      )}
    </div>
  );
}
