/**
 * Tiny event bus so any "Run … now" button can open the Activity window for the run it just started,
 * without the button knowing where the window lives. OWNED BY: web-activity.
 */
export interface OpenActivityRequest {
  projectId: string;
  /** Run to show; omitted = the window picks the active run or the last finished one. */
  runId?: string;
}

type Listener = (req: OpenActivityRequest) => void;
const listeners = new Set<Listener>();

export function openActivity(req: OpenActivityRequest): void {
  for (const fn of Array.from(listeners)) fn(req);
}

export function onOpenActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
