/**
 * Change detection between two checks of one backlink (pure; code decides, never a model). The first check of a
 * backlink is the baseline and produces no events. Messages are plain text built from stored values only.
 */
import { FOUND_STATUSES, normAnchor, type BacklinkEventKind, type BacklinkStatus, type LinkRel } from "@shared/backlinks";

export interface CheckSnapshot {
  status: BacklinkStatus;
  linkRel: LinkRel | null;
  httpStatus: number | null;
  finalUrl: string | null;
  anchorFound: string | null;
  pageNoindex: boolean;
  targetStatus: number | null;
  targetError: string | null;
  canonicalUrl: string | null;
  linkMatch: "target" | "host" | "none" | null;
  /** First matching link's href (for "now points to …"). */
  linkHref: string | null;
  statusReason: string | null;
}

export interface DetectedEvent {
  kind: BacklinkEventKind;
  from: string | null;
  to: string | null;
  message: string;
  negative: boolean;
}

const isFound = (s: BacklinkStatus) => (FOUND_STATUSES as readonly string[]).includes(s);
/** Statuses where the page itself was read (meta robots / anchors are comparable). */
const pageRead = (s: BacklinkStatus) => isFound(s) || s === "missing" || s === "redirected";
const ERROR_STATES: readonly BacklinkStatus[] = ["page_error", "redirected", "robots_blocked", "fetch_failed"];

const relWord = (s: BacklinkStatus | LinkRel | null) => (s === null ? "unknown" : s);

/** Target state: ok (2xx/3xx), broken (4xx/5xx or unreachable), or unknown (not checked / robots / never). */
export function targetState(status: number | null, error: string | null): "ok" | "broken" | "unknown" {
  if (status !== null) return status >= 400 ? "broken" : "ok";
  if (error === null || error === "not_checked" || error === "robots_blocked") return "unknown";
  return "broken";
}

export function diffChecks(prev: CheckSnapshot | null, next: CheckSnapshot): DetectedEvent[] {
  if (!prev) return [];
  const out: DetectedEvent[] = [];
  const a = prev.status;
  const b = next.status;
  if (a !== b) {
    if (isFound(a) && isFound(b)) {
      out.push({
        kind: "rel_changed",
        from: a,
        to: b,
        message: `${relWord(a)} → ${relWord(b)}`,
        negative: a === "dofollow",
      });
    } else if (b === "missing") {
      out.push({
        kind: "link_removed",
        from: a,
        to: b,
        message: isFound(a) ? `Link removed: the ${a} link to your site is no longer on the page` : "Page is reachable again, but the link to your site is missing",
        negative: true,
      });
    } else if (isFound(b) && a === "missing") {
      out.push({ kind: "link_restored", from: a, to: b, message: `Link restored (now ${b})`, negative: false });
    } else if (isFound(b) && ERROR_STATES.includes(a)) {
      out.push({ kind: "recovered", from: a, to: b, message: `Recovered: page OK again, link ${b}`, negative: false });
    } else if (b === "page_error") {
      out.push({ kind: "page_error", from: a, to: String(next.httpStatus ?? "error"), message: `Page now ${next.httpStatus ?? "error"}`, negative: true });
    } else if (b === "redirected") {
      out.push({ kind: "redirected", from: a, to: next.finalUrl, message: `Redirected to ${next.finalUrl ?? "another URL"}`, negative: true });
    } else if (b === "robots_blocked") {
      out.push({ kind: "robots_blocked", from: a, to: b, message: "robots.txt now blocks the page (not fetched, link not verified)", negative: false });
    } else if (b === "fetch_failed") {
      out.push({ kind: "fetch_failed", from: a, to: b, message: `Page could not be fetched${next.statusReason ? `: ${next.statusReason}` : ""}`, negative: false });
    }
  } else if (b === "redirected" && (prev.finalUrl ?? "") !== (next.finalUrl ?? "")) {
    out.push({ kind: "redirected", from: prev.finalUrl, to: next.finalUrl, message: `Now redirects to ${next.finalUrl ?? "another URL"}`, negative: false });
  } else if (b === "page_error" && prev.httpStatus !== next.httpStatus) {
    out.push({ kind: "page_error", from: String(prev.httpStatus ?? ""), to: String(next.httpStatus ?? ""), message: `Page now ${next.httpStatus ?? "error"} (was ${prev.httpStatus ?? "error"})`, negative: false });
  }

  // On a redirected article, the link on the final page can change too.
  if (a === "redirected" && b === "redirected" && prev.linkRel !== next.linkRel && prev.linkRel && next.linkRel) {
    out.push({ kind: "rel_changed", from: prev.linkRel, to: next.linkRel, message: `On the redirected page: ${prev.linkRel} → ${next.linkRel}`, negative: prev.linkRel === "dofollow" });
  }

  if (pageRead(a) && pageRead(b)) {
    if (!prev.pageNoindex && next.pageNoindex) out.push({ kind: "noindex_added", from: "index", to: "noindex", message: "noindex added to the page", negative: true });
    if (prev.pageNoindex && !next.pageNoindex) out.push({ kind: "noindex_removed", from: "noindex", to: "index", message: "noindex removed from the page", negative: false });
    if (prev.anchorFound !== null && next.anchorFound !== null && normAnchor(prev.anchorFound) !== normAnchor(next.anchorFound)) {
      out.push({ kind: "anchor_changed", from: prev.anchorFound, to: next.anchorFound, message: `Anchor changed: "${prev.anchorFound}" → "${next.anchorFound}"`, negative: false });
    }
    if (prev.linkMatch === "target" && next.linkMatch === "host") {
      out.push({ kind: "target_moved", from: null, to: next.linkHref, message: `Link now points to ${next.linkHref ?? "another page of your site"} instead of the target`, negative: true });
    }
    if (!prev.canonicalUrl && next.canonicalUrl) {
      out.push({ kind: "canonical_changed", from: null, to: next.canonicalUrl, message: `Canonical now points to ${next.canonicalUrl}`, negative: false });
    }
  }

  const ta = targetState(prev.targetStatus, prev.targetError);
  const tb = targetState(next.targetStatus, next.targetError);
  if (ta === "ok" && tb === "broken") {
    out.push({ kind: "target_broken", from: String(prev.targetStatus ?? ""), to: String(next.targetStatus ?? next.targetError ?? ""), message: `Target now ${next.targetStatus ?? next.targetError ?? "unreachable"}`, negative: true });
  } else if (ta === "broken" && tb === "ok") {
    out.push({ kind: "target_recovered", from: String(prev.targetStatus ?? prev.targetError ?? ""), to: String(next.targetStatus ?? ""), message: `Target back to ${next.targetStatus}`, negative: false });
  }
  return out.map((e) => ({ ...e, message: e.message.slice(0, 500), from: e.from?.slice(0, 500) ?? null, to: e.to?.slice(0, 500) ?? null }));
}
