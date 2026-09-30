/**
 * robots.txt advisor [A19]: a suggestion for review, never applied automatically.
 *
 * Why it exists: under RFC 9309 a crawler that matches a named group ignores the "*" group. A bare
 * "User-agent: Googlebot / Allow: /" snippet therefore silently drops the site's "*" rules (for example
 * Shopify's default /cart, /checkout, /account, and search disallows) for that crawler. This module
 * builds a suggestion that:
 *  - keeps every existing line it does not need to change (groups, comments, Sitemap lines);
 *  - gives each search-engine and AI answer/search crawler (and training crawler when the user allows
 *    training) a named group that repeats every "*" rule, minus rules that block the site root;
 *  - for a crawler that already has its own group: keeps that group unless it blocks the site root, in
 *    which case only the root-blocking Disallow is dropped (and the "*" rules are added so opening the
 *    group does not expose /cart etc.);
 *  - training crawlers when training is not allowed: a "Disallow: /" group;
 *  - user-initiated fetchers: never changed, only reported.
 * The result is re-parsed with the crawler's own RFC 9309 evaluator and refused if any other user
 * agent's effective rules would change.
 *
 * Pure: no I/O. The route fetches robots.txt through the SSRF guard and calls buildRobotsSuggestion.
 */
import type { CrawlerPurpose, RobotsSuggestion } from "@shared/types";
import { isPathAllowed, parseRobots, selectGroup, type ParsedRobots, type RobotsGroup } from "./crawl/robots";
import { AI_CRAWLERS, AI_CRAWLERS_VERIFIED_ON, AI_CRAWLERS_VERSION, selectCrawlerGroup, type AiCrawlerDef } from "./rules/ai-crawlers";

export type RobotsSuggestionCore = Omit<RobotsSuggestion, "state" | "fetchedAt" | "currentRobotsTxt">;
type Before = RobotsSuggestion["changes"][number]["before"];
type After = RobotsSuggestion["changes"][number]["after"];

export interface RobotsAdvisorOptions {
  allowTraining: boolean;
  /** Project site type (ecommerce | saas | publisher | local | other). */
  siteType: string;
  /** Verified host, used only in notes. */
  host: string | null;
  /** Override the crawler list (tests). Defaults to AI_CRAWLERS. */
  crawlers?: readonly AiCrawlerDef[];
}

export const ADVISOR_REVIEW_LABEL = "Suggestion for review — Okara never edits your robots.txt.";
export const CDN_WARNING =
  "CDN or WAF bot protection (e.g., Cloudflare AI bot blocking) can block these crawlers regardless of robots.txt; check your CDN settings — this app does not test by impersonating crawler user-agents.";
export const NO_GUARANTEE_NOTE = "Allowing crawlers does not guarantee citations.";

// ------------------------------------------------------------------------------------ line model

type LineKind = "blank" | "comment" | "agent" | "sitemap" | "directive" | "invalid";

interface RLine {
  raw: string;
  kind: LineKind;
  /** Lowercased directive key ("user-agent", "disallow", ...). */
  key: string;
  value: string;
  /** Key as written, without surrounding space. */
  keyText: string;
  /** Lowercased product token for agent lines. */
  token: string;
  group: number | null;
}

interface LineGroup {
  index: number;
  agentLines: number[];
  directiveLines: number[];
  agents: string[];
}

interface LineModel {
  lines: RLine[];
  groups: LineGroup[];
}

/** Same product-token rule as crawl/robots.ts ("Googlebot/2.1" -> "googlebot"). */
function productToken(value: string): string {
  const v = value.trim();
  if (v === "*") return "*";
  const m = /^[A-Za-z_-]+/.exec(v);
  return m ? m[0].toLowerCase() : "";
}

/**
 * Structured parse that keeps every original line. Group boundaries follow crawl/robots.ts exactly:
 * consecutive user-agent lines (Sitemap lines do not interrupt them) start one group; any other
 * directive ends the agent list.
 */
function parseLines(text: string): LineModel {
  const body = text.replace(/^﻿/, "");
  const raws = body.split(/\r\n|\r|\n/);
  if (raws.length > 0 && raws[raws.length - 1] === "") raws.pop();
  const lines: RLine[] = [];
  const groups: LineGroup[] = [];
  let current: LineGroup | null = null;
  let lastWasAgent = false;
  raws.forEach((raw, i) => {
    const stripped = raw.replace(/#.*$/, "").trim();
    const line: RLine = { raw, kind: "blank", key: "", value: "", keyText: "", token: "", group: null };
    lines.push(line);
    if (!stripped) {
      line.kind = raw.trim() ? "comment" : "blank";
      return;
    }
    const idx = stripped.indexOf(":");
    if (idx < 0) {
      line.kind = "invalid";
      return;
    }
    line.keyText = stripped.slice(0, idx).trim();
    line.key = line.keyText.toLowerCase();
    line.value = stripped.slice(idx + 1).trim();
    if (line.key === "user-agent") {
      line.kind = "agent";
      line.token = productToken(line.value);
      if (!lastWasAgent || !current) {
        current = { index: groups.length, agentLines: [], directiveLines: [], agents: [] };
        groups.push(current);
      }
      current.agentLines.push(i);
      if (line.token) current.agents.push(line.token);
      line.group = current.index;
      lastWasAgent = true;
      return;
    }
    if (line.key === "sitemap") {
      line.kind = "sitemap";
      return;
    }
    lastWasAgent = false;
    line.kind = "directive";
    if (current) {
      current.directiveLines.push(i);
      line.group = current.index;
    }
  });
  return { lines, groups };
}

// ------------------------------------------------------------------------------------ directives

interface Directive {
  kind: "allow" | "disallow" | "other";
  key: string; // lowercased
  path: string;
  text: string; // canonical output line
}

function toDirective(line: RLine): Directive | null {
  if (line.key === "allow" || line.key === "disallow") {
    if (line.value === "") return null; // an empty rule matches nothing
    const kind = line.key as "allow" | "disallow";
    return { kind, key: kind, path: line.value, text: `${kind === "allow" ? "Allow" : "Disallow"}: ${line.value}` };
  }
  const keyText = line.key === "crawl-delay" ? "Crawl-delay" : line.keyText;
  return { kind: "other", key: line.key, path: "", text: `${keyText}: ${line.value}` };
}

const EMPTY_GROUP: Omit<RobotsGroup, "rules"> = { agents: [], crawlDelay: null };

/** A Disallow rule that matches the site root ("/", "/*", "*", "/$", ...). */
function blocksRoot(d: Directive): boolean {
  return d.kind === "disallow" && !isPathAllowed({ ...EMPTY_GROUP, rules: [{ allow: false, path: d.path }] }, "/");
}

/** Whether a "*" directive is already covered by a crawler's own rules (one Crawl-delay per group). */
function covered(own: Directive[], d: Directive): boolean {
  if (d.key === "crawl-delay") return own.some((x) => x.key === "crawl-delay");
  if (d.kind === "other") return own.some((x) => x.text === d.text);
  return own.some((x) => x.kind === d.kind && x.path === d.path);
}

// ------------------------------------------------------------------------------------ evaluation

export function classifyAccess(group: RobotsGroup | null): Before {
  if (!group) return "no_group";
  const rootAllowed = isPathAllowed(group, "/");
  const hasAllow = group.rules.some((r) => r.allow);
  const hasDisallow = group.rules.some((r) => !r.allow);
  if (!rootAllowed) return hasAllow ? "partial" : "blocked";
  return hasDisallow ? "partial" : "allowed";
}

const EMPTY_PARSED: ParsedRobots = { groups: [], sitemaps: [] };

/** Rules + crawl-delay a token would use (RFC 9309 selection). Agents are ignored for comparison. */
function effectiveKey(parsed: ParsedRobots, token: string): string {
  const g = selectGroup(parsed, token);
  return g ? JSON.stringify({ rules: g.rules, crawlDelay: g.crawlDelay }) : "none";
}

// ------------------------------------------------------------------------------------ builder

type Target = "allow" | "block" | null;

interface Plan {
  def: AiCrawlerDef;
  target: Target;
  action: "keep" | "add" | "replace";
  before: Before;
  after: After;
  lines: string[];
  ownGroups: LineGroup[];
  starRulesCopied: boolean;
}

function looksShopify(text: string | null): boolean {
  if (!text) return false;
  return /shopify/i.test(text) || (/\/checkouts?\b/i.test(text) && /sort_by/i.test(text));
}

const quoteList = (xs: string[], max = 3) => xs.slice(0, max).join(", ") + (xs.length > max ? `, and ${xs.length - max} more` : "");

export function buildRobotsSuggestion(robotsTxt: string | null, opts: RobotsAdvisorOptions): RobotsSuggestionCore {
  const crawlers = opts.crawlers ?? AI_CRAWLERS;
  const model: LineModel = robotsTxt === null ? { lines: [], groups: [] } : parseLines(robotsTxt);
  const parsed = robotsTxt === null ? EMPTY_PARSED : parseRobots(robotsTxt);
  const warnings: string[] = [];
  const notes: string[] = [ADVISOR_REVIEW_LABEL, NO_GUARANTEE_NOTE];

  // "*" directives in file order (every group that lists "*", as RFC 9309 combines them).
  const starDirectives: Directive[] = [];
  for (const g of model.groups) {
    if (!g.agents.includes("*")) continue;
    for (const i of g.directiveLines) {
      const d = toDirective(model.lines[i]!);
      if (d) starDirectives.push(d);
    }
  }
  const starRootBlockers = starDirectives.filter(blocksRoot);
  const baseStar = starDirectives.filter((d) => !blocksRoot(d));

  const plans: Plan[] = crawlers.map((def) => {
    const token = def.token.toLowerCase();
    const ownGroups = model.groups.filter((g) => g.agents.includes(token));
    const before = classifyAccess(selectCrawlerGroup(parsed, def));
    const target: Target =
      def.purpose === "user_fetch" ? null : def.purpose === "training" ? (opts.allowTraining ? "allow" : "block") : "allow";
    const plan: Plan = { def, target, action: "keep", before, after: "unchanged", lines: [], ownGroups, starRulesCopied: false };
    if (target === null) return plan;

    const ownCombined = ownGroups.length > 0 ? selectGroup(parsed, token) : null;
    if (target === "block") {
      if (ownCombined && !isPathAllowed(ownCombined, "/")) return plan; // already blocked by its own group
      plan.action = ownGroups.length > 0 ? "replace" : "add";
      plan.after = "blocked";
      plan.lines = ["Disallow: /"];
      return plan;
    }

    // target === "allow"
    if (ownCombined && isPathAllowed(ownCombined, "/")) return plan; // own group already allows the root: keep it
    const lines: Directive[] = [];
    if (ownGroups.length > 0) {
      for (const g of ownGroups)
        for (const i of g.directiveLines) {
          const d = toDirective(model.lines[i]!);
          if (d && !blocksRoot(d) && !lines.some((x) => x.text === d.text)) lines.push(d);
        }
    }
    for (const d of baseStar) if (!covered(lines, d)) lines.push(d);
    plan.action = ownGroups.length > 0 ? "replace" : "add";
    plan.after = "allowed";
    plan.starRulesCopied = baseStar.length > 0;
    plan.lines = [...lines.map((d) => d.text), ...(lines.some((d) => d.kind === "allow" && d.path === "/") ? [] : ["Allow: /"])];
    return plan;
  });

  // ---------------------------------------------------------------- rewrite
  const changing = plans.filter((p) => p.action !== "keep");
  const stripTokens = new Set(changing.filter((p) => p.action === "replace").map((p) => p.def.token.toLowerCase()));
  const removed = new Set<number>();
  const splitNotes: string[] = [];
  for (const g of model.groups) {
    const stripped = g.agentLines.filter((i) => stripTokens.has(model.lines[i]!.token));
    if (stripped.length === 0) continue;
    for (const i of stripped) removed.add(i);
    if (stripped.length === g.agentLines.length) {
      for (const i of g.directiveLines) removed.add(i); // the whole group moves into the suggested groups
    } else {
      const moved = stripped.map((i) => model.lines[i]!.value);
      const kept = g.agentLines.filter((i) => !removed.has(i)).map((i) => model.lines[i]!.value);
      splitNotes.push(`${quoteList(moved)} shared a group with ${quoteList(kept)}; the suggestion gives ${moved.length > 1 ? "them their" : "it its"} own group and leaves the rules for ${quoteList(kept)} unchanged.`);
    }
  }

  // Generated block: one group per distinct rule set, search crawlers first, then training.
  const sections: Array<{ title: string; purposes: CrawlerPurpose[] }> = [
    { title: "Search engines and AI answer/search crawlers", purposes: ["search_engine", "answer_search"] },
    { title: `AI training crawlers (your call: ${opts.allowTraining ? "allowed" : "blocked"})`, purposes: ["training"] },
  ];
  const generated: string[] = [];
  for (const s of sections) {
    const buckets = new Map<string, { tokens: string[]; lines: string[]; replaced: string[] }>();
    for (const p of changing.filter((x) => s.purposes.includes(x.def.purpose))) {
      const key = p.lines.join("\n");
      const b = buckets.get(key) ?? { tokens: [], lines: p.lines, replaced: [] };
      b.tokens.push(p.def.token);
      if (p.action === "replace") b.replaced.push(p.def.token);
      buckets.set(key, b);
    }
    if (buckets.size === 0) continue;
    generated.push("", `# ${s.title}`);
    let first = true;
    for (const b of buckets.values()) {
      if (!first) generated.push("");
      first = false;
      if (b.replaced.length > 0) {
        generated.push(
          s.purposes.includes("training") && !opts.allowTraining
            ? `# Replaces the earlier group for ${b.replaced.join(", ")}.`
            : `# Earlier rules for ${b.replaced.join(", ")} kept, without the site-wide Disallow.`,
        );
      }
      for (const t of b.tokens) generated.push(`User-agent: ${t}`);
      generated.push(...b.lines);
    }
  }
  let suggested: string | null = null;
  if (generated.length > 0) {
    generated.splice(
      1,
      0,
      ...(baseStar.length > 0
        ? [
            "# Suggested by Okara for review. A crawler that matches a named group ignores the \"*\" group",
            "# (RFC 9309), so the \"*\" rules are repeated in each allowed group below.",
          ]
        : ["# Suggested by Okara for review."]),
    );
  }
  const kept = model.lines.map((l, i) => (removed.has(i) ? null : l.raw));
  // Insert before a trailing group that has no directives (it would otherwise absorb our first group).
  let insertAt = kept.length;
  const last = model.groups[model.groups.length - 1];
  if (last && last.directiveLines.length === 0 && last.agentLines.some((i) => !removed.has(i))) insertAt = last.agentLines[0]!;
  if (generated.length > 0 || robotsTxt !== null) {
    const head = kept.slice(0, insertAt).filter((l): l is string => l !== null);
    const tail = kept.slice(insertAt).filter((l): l is string => l !== null);
    while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop();
    const block = head.length === 0 ? generated.slice(generated[0] === "" ? 1 : 0) : generated;
    const out = [...head, ...block, ...(tail.length > 0 && block.length > 0 ? [""] : []), ...tail];
    // Collapse runs of blank lines we may have created by removing lines.
    const collapsed = out.filter((l, i) => !(l.trim() === "" && i > 0 && out[i - 1]!.trim() === ""));
    suggested = collapsed.join("\n").replace(/^\n+/, "") + "\n";
  }

  // ---------------------------------------------------------------- self-check with the RFC 9309 evaluator
  if (suggested !== null && !verifySuggestion(parsed, suggested, plans, baseStar)) {
    warnings.push("Okara could not build a suggestion that keeps every other user agent's rules unchanged, so no suggestion is shown. Edit robots.txt manually using the notes below.");
    suggested = null;
  }

  // ---------------------------------------------------------------- warnings
  if (looksShopify(robotsTxt)) {
    warnings.push(
      "This robots.txt looks platform-managed (Shopify). On Shopify, change it by editing the robots.txt.liquid theme template rather than replacing the file. Shopify's default rules keep crawlers out of checkout, cart, account, and internal search pages — do not delete them.",
    );
  } else if (opts.siteType === "ecommerce") {
    warnings.push(
      "Ecommerce platforms often generate robots.txt (for example Shopify's robots.txt.liquid template). Edit it through your platform's supported method and keep the default rules that protect cart, checkout, account, and search pages.",
    );
  }
  warnings.push(CDN_WARNING);
  if (starRootBlockers.length > 0) {
    warnings.push(
      `Your "*" group disallows the whole site (${quoteList(starRootBlockers.map((d) => d.text))}). The suggested named groups leave that rule out so the selected crawlers can reach your pages; if the block is intentional (for example a staging site), do not apply this suggestion.`,
    );
  }
  for (const p of plans) {
    if (p.action !== "keep" || p.target !== "allow" || p.ownGroups.length === 0 || baseStar.length === 0) continue;
    const own = selectGroup(parsed, p.def.token);
    const missing = baseStar.filter((d) => d.kind === "disallow" && !(own?.rules ?? []).some((r) => !r.allow && r.path === d.path)).map((d) => d.text);
    if (missing.length > 0) {
      warnings.push(
        `${p.def.token} has its own group, so your "*" rules do not apply to it (for example ${quoteList(missing, 2)}). Okara left that group unchanged; review whether this is intended.`,
      );
    }
  }
  warnings.push("robots.txt is advisory, not access control: compliant crawlers follow it, but it does not protect private pages. Use authentication for anything private.");
  warnings.push(
    "Google-Extended does not affect Google Search or AI Overviews: Google says it has no impact on inclusion or ranking in Google Search, and AI Overviews draw on the normal Search index.",
  );
  warnings.push("Blocking training crawlers is a business choice, not a defect.");
  for (const p of plans) {
    if (p.def.purpose === "user_fetch" && p.def.robotsMayNotApply && p.before === "blocked") {
      warnings.push(`${p.def.token} is disallowed for the whole site, but ${p.def.vendor} says robots.txt may not apply to user-initiated fetches.`);
    }
  }

  // ---------------------------------------------------------------- notes
  if (robotsTxt === null) {
    notes.push(
      "No robots.txt was found, so every crawler is currently allowed (RFC 9309 treats a missing robots.txt as allow-all). The suggested named groups only make your policy explicit.",
    );
  } else if (model.groups.length === 0) {
    notes.push("robots.txt has no user-agent groups, so every crawler is currently allowed. The suggested named groups only make your policy explicit.");
  }
  if (changing.some((p) => p.target === "allow") && baseStar.length > 0) {
    notes.push('Named groups do not inherit later changes to the "*" group: when you add a rule to "*", add it to each named group too.');
  }
  notes.push('"Allowed" in the changes table means the site root is crawlable; path rules copied from "*" (such as /cart) still apply.');
  notes.push("User-initiated fetchers (for example ChatGPT-User) are reported but never changed by this suggestion.");
  notes.push(...splitNotes);
  for (const p of plans) {
    if (p.action === "keep" || !p.def.robotsFallback?.length || p.ownGroups.length > 0) continue;
    const fb = p.def.robotsFallback.find((t) => model.groups.some((g) => g.agents.includes(t.toLowerCase())));
    if (fb) notes.push(`${p.def.token} currently follows your ${fb} group (${p.def.vendor} documents this fallback); the suggestion gives it its own group.`);
  }
  if (parsed.sitemaps.length === 0 && opts.host) {
    notes.push(`No Sitemap line found. If the site has an XML sitemap, you can list it with a line such as "Sitemap: https://${opts.host}/sitemap.xml".`);
  }
  notes.push("To see how AI assistants describe your category, use your GEO prompts in Okara or ask ChatGPT and Perplexity directly; answers vary and do not show whether a crawler visited.");
  notes.push(`Crawler token list version ${AI_CRAWLERS_VERSION} (checked against vendor documentation on ${AI_CRAWLERS_VERIFIED_ON}).`);

  const preservedRules = changing.some((p) => p.target === "allow" && p.starRulesCopied) ? [...new Set(baseStar.map((d) => d.text))] : [];

  return {
    policy: { allowTraining: opts.allowTraining },
    suggestedRobotsTxt: suggested,
    preservedRules,
    changes: plans.map((p) => ({ token: p.def.token, purpose: p.def.purpose, before: p.before, after: p.after })),
    warnings,
    notes,
  };
}

/**
 * Re-parse the suggestion and check: every changed crawler reaches (or is kept out of) the root as
 * planned; allowed groups still carry every non-root "*" Disallow; every other user agent (and "*")
 * keeps exactly its current rules.
 */
function verifySuggestion(beforeParsed: ParsedRobots, suggested: string, plans: Plan[], baseStar: Directive[]): boolean {
  const after = parseRobots(suggested);
  const changed = new Set(plans.filter((p) => p.action !== "keep").map((p) => p.def.token.toLowerCase()));
  for (const p of plans) {
    if (p.action === "keep") continue;
    const g = selectGroup(after, p.def.token);
    if (!g || !g.agents.includes(p.def.token.toLowerCase())) return false;
    const root = isPathAllowed(g, "/");
    if (p.target === "allow") {
      if (!root) return false;
      for (const d of baseStar) {
        if (d.kind === "disallow" && !g.rules.some((r) => !r.allow && r.path === d.path)) {
          // Only allowed when the crawler's own earlier group explicitly allowed that exact path.
          if (!g.rules.some((r) => r.allow && r.path === d.path)) return false;
        }
      }
    } else if (p.target === "block" && root) return false;
  }
  const others = new Set<string>(["*", "okara-advisor-probe"]);
  for (const g of beforeParsed.groups) for (const a of g.agents) if (!changed.has(a)) others.add(a);
  for (const p of plans) if (p.action === "keep") others.add(p.def.token.toLowerCase());
  for (const t of others) if (effectiveKey(beforeParsed, t) !== effectiveKey(after, t)) return false;
  return true;
}

/**
 * Demo robots.txt (DEMO_MODE projects only). Illustrative and abridged: it resembles a typical Shopify
 * default (cart, checkout, account, search, and filtered-collection disallows) on the reserved demo
 * host. It is not fetched from anywhere and is labelled as demo data.
 */
export function demoRobotsTxt(demoOrigin: string, label: string): string {
  return `# ${label}: illustrative robots.txt resembling a typical Shopify default (abridged).
# we use Shopify as our ecommerce platform

User-agent: *
Disallow: /a/downloads/-/*
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts/
Disallow: /checkout
Disallow: /carts
Disallow: /account
Disallow: /collections/*sort_by*
Disallow: /*/collections/*sort_by*
Disallow: /collections/*+*
Disallow: /collections/*%2B*
Disallow: /collections/*%2b*
Disallow: /blogs/*+*
Disallow: /*?*oseid=*
Disallow: /*preview_theme_id*
Disallow: /*preview_script_id*
Disallow: /policies/
Disallow: /search
Allow: /search/
Disallow: /search/?*
Disallow: /recommendations/products
Disallow: /*/recommendations/products
Disallow: /products/*-remote
Sitemap: ${demoOrigin}/sitemap.xml

# Google adsbot ignores robots.txt unless specifically named!
User-agent: adsbot-google
Disallow: /checkouts/
Disallow: /checkout
Disallow: /carts
Disallow: /orders
Disallow: /*?*oseid=*
Disallow: /*preview_theme_id*
Disallow: /*preview_script_id*

User-agent: Nutch
Disallow: /

User-agent: AhrefsBot
Crawl-delay: 10
Disallow: /cart
Disallow: /checkout

User-agent: Pinterest
Crawl-delay: 1
`;
}
