/** [A25] Link-context sentence extraction at crawl time. */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { CAPS, extractPage, linkContextSentences, LINK_CONTEXT_MAX_WORDS, LINK_CONTEXT_MIN_WORDS, splitSentences } from "@worker/seo/crawl/extract";
import { runCrawl } from "@worker/seo/crawl/run";
import { createTestEnv } from "./helpers/env";
import { seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeSite, html } from "./fixtures/crawl/fake-site";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

describe("links: sentence splitting", () => {
  it("splits on terminal punctuation but not after abbreviations, initials, or decimals", () => {
    expect(splitSentences("Measure the door first. Then pick a pull! Is brass right? Yes.")).toEqual([
      "Measure the door first.",
      "Then pick a pull!",
      "Is brass right?",
      "Yes.",
    ]);
    expect(splitSentences("Dr. Smith prefers brass, e.g. for humid rooms. J. R. Maker agrees with a 3.5 mm gap.")).toEqual([
      "Dr. Smith prefers brass, e.g. for humid rooms.",
      "J. R. Maker agrees with a 3.5 mm gap.",
    ]);
    expect(splitSentences('He said "Use brass." Then he left.')).toEqual(['He said "Use brass."', "Then he left."]);
    expect(splitSentences("lower case after a period. does not split")).toEqual(["lower case after a period. does not split"]);
  });

  it("keeps sentences of 6..60 words, caps each at 240 characters and the list at 40, and drops duplicates", () => {
    const tooShort = "Only five words are here.";
    const six = "Exactly six words are right here.";
    const sixty = `${words(59)} end.`;
    const sixtyOne = `${words(60)} end.`;
    expect(LINK_CONTEXT_MIN_WORDS).toBe(6);
    expect(LINK_CONTEXT_MAX_WORDS).toBe(60);
    const out = linkContextSentences([`${tooShort} ${six} ${six}`, sixtyOne, sixty]);
    expect(out[0]).toBe(six);
    expect(out).toHaveLength(2); // duplicate six-word sentence dropped; 61 words dropped
    expect(out[1]!.length).toBeLessThanOrEqual(CAPS.linkContextChars);
    expect(out[1]!.endsWith("…")).toBe(true);

    const many = Array.from({ length: 55 }, (_, i) => `Sentence number ${i} talks about solid brass pulls.`).join(" ");
    const capped = linkContextSentences([many]);
    expect(capped).toHaveLength(CAPS.linkContextSentences);
    expect(CAPS.linkContextSentences).toBe(40);
  });
});

describe("links: extractPage link context", () => {
  const PAGE = `<!doctype html><html><head><title>Choosing hardware</title></head><body>
<header><p>Free shipping on all orders over fifty dollars this week only.</p></header>
<nav><a href="/">Home</a> <a href="/collections/pulls">Shop all of our cabinet pulls and knobs today</a></nav>
<main>
<h1>How to choose cabinet hardware for your kitchen cabinets</h1>
<p>Choosing cabinet hardware starts with the size of the door. Measure the drawer width, e.g. 40 cm, before you buy. Dr. Smith recommends <a href="/products/brass-pull">solid brass pulls</a> for humid rooms!</p>
<p>Too short here.</p>
<ul><li>Brass pulls suit shaker style kitchen cabinets very well</li><li>Short item</li></ul>
<button>Add this solid brass pull to your shopping cart now please</button>
<p>${words(70)}.</p>
<script>var x = "This script text should never appear in any sentence at all";</script>
</main>
<aside><p>Related reading about many other things you might like to see.</p></aside>
<footer><p>Copyright notice for the whole site and all of its many pages.</p></footer>
</body></html>`;

  it("keeps main-content prose only: no nav, header, footer, aside, headings, buttons, or scripts", () => {
    const x = extractPage(PAGE, "https://shop.example.com/blogs/news/choosing");
    expect(x.linkContext).toEqual([
      "Choosing cabinet hardware starts with the size of the door.",
      "Measure the drawer width, e.g. 40 cm, before you buy.",
      "Dr. Smith recommends solid brass pulls for humid rooms!",
      "Brass pulls suit shaker style kitchen cabinets very well",
    ]);
    const all = x.linkContext.join(" ");
    for (const banned of ["Free shipping", "Shop all", "How to choose", "Add this", "script text", "Related reading", "Copyright", "Too short", "Short item"]) {
      expect(all).not.toContain(banned);
    }
  });

  it("falls back to body text outside boilerplate when there is no <main>", () => {
    const x = extractPage(
      `<html><body><nav><p>Navigation sentence that has more than six words in it.</p></nav><div><p>Our brass knobs are machined from a single solid bar.</p></div></body></html>`,
      "https://shop.example.com/products/knob",
    );
    expect(x.linkContext).toEqual(["Our brass knobs are machined from a single solid bar."]);
  });
});

describe("links: crawl stores link-context sentences", () => {
  const H = "shop.example.com";
  const U = (p: string) => `https://${H}${p}`;
  const ARTICLE = `<html><head><title>Brass care</title><link rel="canonical" href="${U("/blogs/news/brass-care")}"></head><body><main><h1>Brass care</h1>
<p>Unlacquered brass darkens over time as the metal reacts with air. Clean it with mild soap and warm water, then dry it well.</p></main></body></html>`;
  const site = () =>
    fakeSite({
      [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /\n" },
      [U("/")]: html(`<html><head><title>Home</title></head><body><main><p>Welcome to our small shop of solid brass hardware.</p><a href="/blogs/news/brass-care">Brass care</a></main></body></html>`),
      [U("/blogs/news/brass-care")]: html(ARTICLE),
    });

  async function setup() {
    const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId);
    return { env, db: new Db(env.DB), workspaceId, projectId };
  }

  const sentencesFor = async (db: Db, crawlRunId: string | null, path: string) => {
    const row = await db.first<{ link_context_json: string }>(
      "SELECT s.link_context_json FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE s.crawl_run_id = ? AND p.url = ?",
      crawlRunId,
      U(path),
    );
    return JSON.parse(row!.link_context_json) as string[];
  };

  it("writes link_context_json for crawled pages", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const summary = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site().fetch }));
    expect(await sentencesFor(db, summary.crawlRunId, "/blogs/news/brass-care")).toEqual([
      "Unlacquered brass darkens over time as the metal reacts with air.",
      "Clean it with mild soap and warm water, then dry it well.",
    ]);
  });

  it("re-extracts a reused (same content hash) snapshot that has no sentences yet, and reuses one that has them", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const first = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site().fetch }));
    // Simulate snapshots taken before sentence extraction existed.
    await db.run("UPDATE page_snapshots SET link_context_json = '[]' WHERE crawl_run_id = ?", first.crawlRunId);
    const second = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site().fetch }));
    expect(await sentencesFor(db, second.crawlRunId, "/blogs/news/brass-care")).toHaveLength(2);
    const notes2 = JSON.parse((await db.first<{ notes_json: string }>("SELECT notes_json FROM crawl_runs WHERE id = ?", second.crawlRunId))!.notes_json) as string[];
    expect(notes2.some((n) => /unchanged since the previous crawl/.test(n))).toBe(false);

    const third = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site().fetch }));
    const notes3 = JSON.parse((await db.first<{ notes_json: string }>("SELECT notes_json FROM crawl_runs WHERE id = ?", third.crawlRunId))!.notes_json) as string[];
    expect(notes3.some((n) => /unchanged since the previous crawl \(same content hash\); extraction reused/.test(n))).toBe(true);
    expect(await sentencesFor(db, third.crawlRunId, "/blogs/news/brass-care")).toHaveLength(2);
  });
});
