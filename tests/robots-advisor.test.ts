import { describe, expect, it } from "vitest";
import { buildRobotsSuggestion, CDN_WARNING, demoRobotsTxt, type RobotsAdvisorOptions } from "@worker/seo/robots-advisor";
import { isPathAllowed, parseRobots, selectGroup, type RobotsState } from "@worker/seo/crawl/robots";
import { AI_CRAWLERS, evaluateAiCrawlerAccess } from "@worker/seo/rules/ai-crawlers";
import { runRules, type RuleInput } from "@worker/seo/rules/registry";
import type { CrawlerPurpose, RobotsSuggestion } from "@shared/types";

const SHOPIFY_LIKE = `# we use Shopify as our ecommerce platform

User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts/
Disallow: /checkout
Disallow: /account
Disallow: /collections/*sort_by*
Disallow: /*/collections/*sort_by*
Disallow: /collections/*+*
Disallow: /*?*oseid=*
Disallow: /search
Allow: /search/
Disallow: /search/?*
Sitemap: https://shop.example.com/sitemap.xml

# Google adsbot ignores robots.txt unless specifically named!
User-agent: adsbot-google
Disallow: /checkouts/
Disallow: /checkout

User-agent: Nutch
Disallow: /

User-agent: AhrefsBot
Crawl-delay: 10
Disallow: /cart
`;

const opts = (over: Partial<RobotsAdvisorOptions> = {}): RobotsAdvisorOptions => ({ allowTraining: true, siteType: "ecommerce", host: "shop.example.com", ...over });

const tokensOf = (purposes: CrawlerPurpose[]) => AI_CRAWLERS.filter((c) => purposes.includes(c.purpose)).map((c) => c.token);
const SEARCH = tokensOf(["search_engine", "answer_search"]);
const TRAINING = tokensOf(["training"]);
const USER_FETCH = tokensOf(["user_fetch"]);

/** RFC 9309 evaluation with the crawler's own evaluator. */
const allowed = (robots: string, agent: string, path: string) => isPathAllowed(selectGroup(parseRobots(robots), agent), path);
const change = (s: Pick<RobotsSuggestion, "changes">, token: string) => s.changes.find((c) => c.token === token)!;
const effective = (robots: string, agent: string) => {
  const g = selectGroup(parseRobots(robots), agent);
  return g ? { rules: g.rules, crawlDelay: g.crawlDelay } : null;
};

describe("robots advisor: Shopify-like robots.txt", () => {
  const s = buildRobotsSuggestion(SHOPIFY_LIKE, opts());
  const out = s.suggestedRobotsTxt!;

  it("keeps /cart, /checkout, /account and search disallowed for every named search and answer crawler", () => {
    expect(out).toBeTruthy();
    for (const token of SEARCH) {
      const g = selectGroup(parseRobots(out), token)!;
      expect(g.agents).toContain(token.toLowerCase()); // it now has its own named group
      expect(allowed(out, token, "/")).toBe(true);
      expect(allowed(out, token, "/products/brass-pull")).toBe(true);
      expect(allowed(out, token, "/search/")).toBe(true); // the "*" Allow is copied too
      for (const p of ["/cart", "/checkout", "/checkouts/abc", "/account/login", "/search?q=x", "/collections/pulls?sort_by=price", "/admin"]) {
        expect({ token, p, allowed: allowed(out, token, p) }).toEqual({ token, p, allowed: false });
      }
    }
  });

  it("documents the bug it prevents: a bare Allow: / group would drop the * disallows", () => {
    const naive = `${SHOPIFY_LIKE}\nUser-agent: Googlebot\nAllow: /\n`;
    expect(allowed(naive, "Googlebot", "/cart")).toBe(true);
    expect(allowed(out, "Googlebot", "/cart")).toBe(false);
  });

  it("never outputs Allow: / in a named group without every copied * disallow", () => {
    const parsed = parseRobots(out);
    const starDisallows = selectGroup(parseRobots(SHOPIFY_LIKE), "*")!.rules.filter((r) => !r.allow);
    for (const g of parsed.groups) {
      if (g.agents.includes("*") || !g.rules.some((r) => r.allow && r.path === "/")) continue;
      for (const d of starDisallows) expect(g.rules).toContainEqual(d);
    }
  });

  it("lists the rules carried over from *", () => {
    expect(s.preservedRules).toEqual(expect.arrayContaining(["Disallow: /cart", "Disallow: /checkout", "Disallow: /account", "Disallow: /search", "Allow: /search/"]));
    expect(s.preservedRules).not.toContain("Disallow: /");
  });

  it("keeps every other group, comment and Sitemap line; other agents' effective rules are unchanged", () => {
    for (const line of ["# we use Shopify as our ecommerce platform", "# Google adsbot ignores robots.txt unless specifically named!", "Sitemap: https://shop.example.com/sitemap.xml", "User-agent: adsbot-google", "User-agent: Nutch", "Crawl-delay: 10"]) {
      expect(out).toContain(line);
    }
    for (const agent of ["*", "adsbot-google", "nutch", "ahrefsbot", "OkaraBot", "some-random-bot"]) {
      expect(effective(out, agent)).toEqual(effective(SHOPIFY_LIKE, agent));
    }
    expect(parseRobots(out).sitemaps).toEqual(["https://shop.example.com/sitemap.xml"]);
    expect(out.startsWith(SHOPIFY_LIKE.trimEnd())).toBe(true); // existing content first, untouched
  });

  it("reports per-token changes: search allowed, user fetchers unchanged", () => {
    expect(change(s, "Googlebot")).toEqual({ token: "Googlebot", purpose: "search_engine", before: "partial", after: "allowed" });
    expect(change(s, "OAI-SearchBot")).toMatchObject({ purpose: "answer_search", before: "partial", after: "allowed" });
    for (const t of USER_FETCH) expect(change(s, t).after).toBe("unchanged");
    expect(s.changes.map((c) => c.token)).toEqual(AI_CRAWLERS.map((c) => c.token));
  });

  it("warns about platform-managed robots, CDN/WAF blocking, advisory nature, Google-Extended and training choice", () => {
    const w = s.warnings.join("\n");
    expect(w).toMatch(/robots\.txt\.liquid/);
    expect(w).toMatch(/checkout, cart, account, and internal search/);
    expect(s.warnings).toContain(CDN_WARNING);
    expect(CDN_WARNING).toMatch(/does not test by impersonating crawler user-agents/);
    expect(w).toMatch(/advisory, not access control/);
    expect(w).toMatch(/Google-Extended does not affect Google Search or AI Overviews/);
    expect(w).toMatch(/business choice/);
    expect(s.notes).toContain("Allowing crawlers does not guarantee citations.");
    expect(s.notes.join(" ")).toMatch(/never edits your robots\.txt/);
  });

  it("is idempotent: the suggestion applied to itself changes nothing", () => {
    const again = buildRobotsSuggestion(out, opts());
    expect(again.suggestedRobotsTxt).toBe(out);
    for (const c of again.changes) expect(c.after).toBe("unchanged");
  });
});

describe("robots advisor: existing named groups", () => {
  it("preserves a crawler's own group and removes only its blanket Disallow: / (adding the * rules)", () => {
    const robots = `User-agent: *\nDisallow: /cart\nDisallow: /checkout\n\nUser-agent: OAI-SearchBot\nDisallow: /\nAllow: /blog/\nDisallow: /blog/drafts/\n`;
    const s = buildRobotsSuggestion(robots, opts());
    const out = s.suggestedRobotsTxt!;
    expect(change(s, "OAI-SearchBot")).toMatchObject({ before: "partial", after: "allowed" });
    const g = selectGroup(parseRobots(out), "OAI-SearchBot")!;
    expect(g.rules).not.toContainEqual({ allow: false, path: "/" });
    expect(g.rules).toEqual(expect.arrayContaining([{ allow: true, path: "/blog/" }, { allow: false, path: "/blog/drafts/" }, { allow: false, path: "/cart" }]));
    expect(allowed(out, "OAI-SearchBot", "/")).toBe(true);
    expect(allowed(out, "OAI-SearchBot", "/blog/drafts/x")).toBe(false);
    expect(allowed(out, "OAI-SearchBot", "/checkout")).toBe(false);
    // The old group is gone (only one OAI-SearchBot group remains).
    expect(parseRobots(out).groups.filter((x) => x.agents.includes("oai-searchbot"))).toHaveLength(1);
    expect(out).toMatch(/Earlier rules for OAI-SearchBot kept/);
  });

  it("a plain blanket block becomes the * rules; before is 'blocked'", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: PerplexityBot\nDisallow: /\n`;
    const s = buildRobotsSuggestion(robots, opts());
    expect(change(s, "PerplexityBot")).toMatchObject({ before: "blocked", after: "allowed" });
    expect(allowed(s.suggestedRobotsTxt!, "PerplexityBot", "/")).toBe(true);
    expect(allowed(s.suggestedRobotsTxt!, "PerplexityBot", "/cart")).toBe(false);
  });

  it("leaves a crawler's own group that already allows the root unchanged, and warns that * rules do not apply to it", () => {
    const robots = `User-agent: *\nDisallow: /cart\nDisallow: /checkout\n\nUser-agent: Googlebot\nDisallow: /private/\n`;
    const s = buildRobotsSuggestion(robots, opts());
    expect(change(s, "Googlebot")).toMatchObject({ before: "partial", after: "unchanged" });
    expect(effective(s.suggestedRobotsTxt!, "Googlebot")).toEqual(effective(robots, "Googlebot"));
    expect(s.warnings.join("\n")).toMatch(/Googlebot has its own group, so your "\*" rules do not apply to it \(for example Disallow: \/cart, Disallow: \/checkout\)/);
  });

  it("splits a shared group: the target moves out, the other agent keeps its rules", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: Claude-SearchBot\nUser-agent: SomeOtherBot\nDisallow: /\n`;
    const s = buildRobotsSuggestion(robots, opts());
    const out = s.suggestedRobotsTxt!;
    expect(allowed(out, "Claude-SearchBot", "/")).toBe(true);
    expect(allowed(out, "Claude-SearchBot", "/cart")).toBe(false);
    expect(allowed(out, "SomeOtherBot", "/")).toBe(false);
    expect(effective(out, "SomeOtherBot")).toEqual(effective(robots, "SomeOtherBot"));
    expect(s.notes.join(" ")).toMatch(/Claude-SearchBot shared a group with SomeOtherBot/);
  });

  it("Applebot follows the Googlebot group when it has none (vendor fallback) and gets its own group", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: Googlebot\nDisallow: /\n`;
    const s = buildRobotsSuggestion(robots, opts());
    expect(change(s, "Applebot").before).toBe("blocked");
    expect(change(s, "Googlebot")).toMatchObject({ before: "blocked", after: "allowed" });
    expect(s.notes.join(" ")).toMatch(/Applebot currently follows your googlebot group/);
    for (const t of ["Googlebot", "Applebot"]) {
      expect(allowed(s.suggestedRobotsTxt!, t, "/")).toBe(true);
      expect(allowed(s.suggestedRobotsTxt!, t, "/cart")).toBe(false);
    }
  });

  it("does not let a trailing empty group absorb the suggested groups", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: quxbot\n`;
    const s = buildRobotsSuggestion(robots, opts());
    const out = s.suggestedRobotsTxt!;
    expect(allowed(out, "quxbot", "/cart")).toBe(true); // empty group still allows everything
    expect(selectGroup(parseRobots(out), "quxbot")!.agents).toEqual(["quxbot"]);
    expect(allowed(out, "Googlebot", "/cart")).toBe(false);
  });

  it("handles CRLF line endings and a BOM", () => {
    const robots = "﻿User-agent: *\r\nDisallow: /cart\r\n";
    const out = buildRobotsSuggestion(robots, opts()).suggestedRobotsTxt!;
    expect(out).not.toContain("\r");
    expect(allowed(out, "Bingbot", "/cart")).toBe(false);
    expect(allowed(out, "Bingbot", "/")).toBe(true);
  });
});

describe("robots advisor: training policy", () => {
  it("allowTraining=false gives every training token a Disallow: / group", () => {
    const s = buildRobotsSuggestion(SHOPIFY_LIKE, opts({ allowTraining: false }));
    const out = s.suggestedRobotsTxt!;
    expect(s.policy).toEqual({ allowTraining: false });
    for (const t of TRAINING) {
      expect(change(s, t)).toMatchObject({ purpose: "training", after: "blocked" });
      expect(allowed(out, t, "/")).toBe(false);
      expect(selectGroup(parseRobots(out), t)!.rules).toEqual([{ allow: false, path: "/" }]);
    }
    // Search crawlers are unaffected by the training choice.
    expect(allowed(out, "Googlebot", "/")).toBe(true);
    expect(allowed(out, "Googlebot", "/cart")).toBe(false);
    expect(out).toMatch(/your call: blocked/);
  });

  it("allowTraining=false keeps an existing training block and replaces a training group that allowed the root", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nAllow: /\n`;
    const s = buildRobotsSuggestion(robots, opts({ allowTraining: false }));
    expect(change(s, "GPTBot")).toMatchObject({ before: "blocked", after: "unchanged" });
    expect(change(s, "CCBot")).toMatchObject({ before: "allowed", after: "blocked" });
    expect(allowed(s.suggestedRobotsTxt!, "CCBot", "/")).toBe(false);
    expect(parseRobots(s.suggestedRobotsTxt!).groups.filter((g) => g.agents.includes("ccbot"))).toHaveLength(1);
  });

  it("allowTraining=true opens a blocked training crawler with the * rules copied", () => {
    const robots = `User-agent: *\nDisallow: /cart\nDisallow: /account\n\nUser-agent: GPTBot\nDisallow: /\n`;
    const s = buildRobotsSuggestion(robots, opts({ allowTraining: true }));
    expect(change(s, "GPTBot")).toMatchObject({ before: "blocked", after: "allowed" });
    expect(allowed(s.suggestedRobotsTxt!, "GPTBot", "/")).toBe(true);
    expect(allowed(s.suggestedRobotsTxt!, "GPTBot", "/cart")).toBe(false);
    expect(allowed(s.suggestedRobotsTxt!, "GPTBot", "/account")).toBe(false);
  });
});

describe("robots advisor: missing, empty and unusual robots.txt", () => {
  it("missing robots.txt (404 -> null): only named groups plus a note", () => {
    const s = buildRobotsSuggestion(null, opts({ siteType: "saas" }));
    const out = s.suggestedRobotsTxt!;
    expect(s.preservedRules).toEqual([]);
    for (const c of s.changes) expect(c.before).toBe("no_group");
    for (const t of SEARCH) expect(allowed(out, t, "/")).toBe(true);
    expect(s.notes.join(" ")).toMatch(/No robots\.txt was found/);
    expect(s.warnings.join(" ")).not.toMatch(/robots\.txt\.liquid/); // not ecommerce, not Shopify
    expect(parseRobots(out).groups.every((g) => g.rules.length > 0)).toBe(true);
  });

  it("empty robots.txt: named groups plus a note", () => {
    const s = buildRobotsSuggestion("", opts());
    expect(s.notes.join(" ")).toMatch(/no user-agent groups/);
    expect(allowed(s.suggestedRobotsTxt!, "Googlebot", "/")).toBe(true);
  });

  it("a * group that blocks the whole site: warns and leaves Disallow: / out of named groups only", () => {
    const robots = `User-agent: *\nDisallow: /\nDisallow: /cart\n`;
    const s = buildRobotsSuggestion(robots, opts());
    expect(s.warnings.join(" ")).toMatch(/Your "\*" group disallows the whole site \(Disallow: \/\)/);
    expect(allowed(s.suggestedRobotsTxt!, "*", "/")).toBe(false);
    expect(allowed(s.suggestedRobotsTxt!, "Googlebot", "/")).toBe(true);
    expect(allowed(s.suggestedRobotsTxt!, "Googlebot", "/cart")).toBe(false);
  });

  it("user-initiated fetchers are never changed, only reported", () => {
    const robots = `User-agent: *\nDisallow: /cart\n\nUser-agent: ChatGPT-User\nDisallow: /\n`;
    const s = buildRobotsSuggestion(robots, opts());
    expect(change(s, "ChatGPT-User")).toEqual({ token: "ChatGPT-User", purpose: "user_fetch", before: "blocked", after: "unchanged" });
    expect(effective(s.suggestedRobotsTxt!, "ChatGPT-User")).toEqual(effective(robots, "ChatGPT-User"));
    expect(s.warnings.join(" ")).toMatch(/ChatGPT-User is disallowed for the whole site, but OpenAI says robots\.txt may not apply/);
  });

  it("the demo robots.txt is labelled and resembles a Shopify default", () => {
    const text = demoRobotsTxt("https://demo.example", "Demo data - simulated run");
    expect(text.split("\n")[0]).toMatch(/^# Demo data - simulated run/);
    for (const p of ["/cart", "/checkout", "/account", "/search"]) expect(allowed(text, "*", p)).toBe(false);
    const s = buildRobotsSuggestion(text, opts());
    expect(allowed(s.suggestedRobotsTxt!, "Googlebot", "/checkout")).toBe(false);
  });
});

describe("AI crawler purposes [A19]", () => {
  const robotsOk = (text: string): RobotsState => ({ status: "ok", httpStatus: 200, parsed: parseRobots(text), note: "" });
  const access = (text: string) => evaluateAiCrawlerAccess(robotsOk(text), { present: false, notes: [] }, "https://shop.example.com/");
  const input = (a: ReturnType<typeof access>): RuleInput => ({ siteType: "ecommerce", verifiedHost: "shop.example.com", snapshots: [], sitemapUrls: [], robots: null, aiCrawlerAccess: a });
  const aiFindings = (text: string) => runRules(input(access(text))).filter((f) => f.ruleId === "AI-SEARCH-CRAWLER-BLOCKED");

  it("classifies every documented token by purpose, with source URLs", () => {
    const byToken = Object.fromEntries(AI_CRAWLERS.map((c) => [c.token, c.purpose]));
    expect(byToken).toMatchObject({
      Googlebot: "search_engine",
      Bingbot: "search_engine",
      Applebot: "search_engine",
      "OAI-SearchBot": "answer_search",
      "Claude-SearchBot": "answer_search",
      PerplexityBot: "answer_search",
      "ChatGPT-User": "user_fetch",
      "Claude-User": "user_fetch",
      "Perplexity-User": "user_fetch",
      GPTBot: "training",
      ClaudeBot: "training",
      "Google-Extended": "training",
      "Applebot-Extended": "training",
      CCBot: "training",
    });
    for (const c of AI_CRAWLERS) {
      expect(c.sourceUrl).toMatch(/^https:\/\//);
      expect(c.note.length).toBeGreaterThan(10);
    }
    expect(AI_CRAWLERS.find((c) => c.token === "Google-Extended")!.note).toMatch(/not a separate crawler/);
    expect(AI_CRAWLERS.find((c) => c.token === "ChatGPT-User")!.note).toMatch(/robots\.txt rules may not apply/);
  });

  it("flags blocked search engines and answer crawlers, never training or user fetchers", () => {
    expect(aiFindings("User-agent: Googlebot\nDisallow: /").map((f) => f.evidence.token)).toEqual(["Googlebot", "Applebot"]); // Applebot follows Googlebot
    expect(aiFindings("User-agent: OAI-SearchBot\nDisallow: /").map((f) => f.evidence.token)).toEqual(["OAI-SearchBot"]);
    expect(aiFindings("User-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: Perplexity-User\nDisallow: /")).toEqual([]);
    expect(aiFindings(TRAINING.map((t) => `User-agent: ${t}\nDisallow: /`).join("\n\n"))).toEqual([]);
    const a = access("User-agent: ChatGPT-User\nDisallow: /");
    expect(a.crawlers.find((c) => c.token === "ChatGPT-User")).toMatchObject({ allowed: false, purpose: "user_fetch" });
    expect(a.advisory.join(" ")).toMatch(/may not apply to user-initiated fetches \(informational\)/);
  });

  it("Bingbot uses an msnbot group when it has none (vendor fallback)", () => {
    const a = access("User-agent: msnbot\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(a.crawlers.find((c) => c.token === "Bingbot")!.allowed).toBe(false);
    expect(a.crawlers.find((c) => c.token === "Googlebot")!.allowed).toBe(true);
  });
});
