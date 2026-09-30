/**
 * [A21] Checklists over a real crawl (fake site, no network) plus the extraction fields added for them:
 * image alt counts, viewport meta, breadcrumb markup, and generic internal anchor text.
 */
import { describe, expect, it } from "vitest";
import "@worker/app";
import { Db } from "@worker/lib/db";
import { runCrawl } from "@worker/seo/crawl/run";
import { extractPage, isGenericAnchorText } from "@worker/seo/crawl/extract";
import { getPageChecklist, getProjectChecklist } from "@worker/checklists/service";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeSite, html } from "./fixtures/crawl/fake-site";
import { projectRow } from "./checklists-seed";

const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;

const head = (title: string, path: string, extra = "") =>
  `<head><title>${title}</title><meta name="description" content="Description for ${path} that is unique and useful to readers."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${U(path)}">${extra}</head>`;

const HOME = `<!doctype html><html>${head("Residence Example: solid brass cabinet hardware and lighting", "/", '<script type="application/ld+json">{"@type":"Organization","name":"Residence Example"}</script>')}
<body><header><img src="/logo.png" alt="Residence Example"></header><main><h1>Solid brass hardware</h1>
<p>Solid brass cabinet hardware and lighting, made to order in small batches for homes.</p>
<a href="/collections/pulls">Cabinet pulls</a> <a href="/blog/how-to-choose-brass-pulls">read more</a> <a href="/members">Members</a>
<img src="/hero.jpg"><img src="/divider.png" role="presentation"></main></body></html>`;

const COLLECTION = `<html>${head("Solid brass cabinet pulls in six finishes | Residence Example", "/collections/pulls", '<script type="application/ld+json">{"@type":"CollectionPage"}</script>')}
<body><nav aria-label="Breadcrumb"><a href="/">Home</a> › Pulls</nav><main><h1>Cabinet pulls</h1>
<p>Our pulls are machined from solid brass bar stock and finished by hand in six finishes.</p>
<a href="/blog/how-to-choose-brass-pulls">How to choose brass pulls</a> <a href="/">Home</a></main></body></html>`;

const ARTICLE = `<html>${head("How to choose brass cabinet pulls for kitchens and baths", "/blog/how-to-choose-brass-pulls", '<meta name="author" content="Jane Maker"><meta property="article:modified_time" content="2026-08-01T00:00:00Z"><script type="application/ld+json">{"@type":"BlogPosting","headline":"How to choose","author":{"name":"Jane Maker"}}</script>')}
<body><main><h1>How to choose brass cabinet pulls</h1><p>Choose brass pulls by size, finish, and projection; measure your drawers first.</p>
<h2>What size pull do I need?</h2><p>Most drawers use 96 mm or 128 mm centers.</p><h2>Which finish lasts longest?</h2>
<table><tr><th>Finish</th><th>Patina</th></tr><tr><td>Unlacquered</td><td>Yes</td></tr></table>
<p>${"Brass is an alloy of copper and zinc used for hardware. ".repeat(30)}</p>
<a href="https://www.nist.gov/materials">NIST materials data</a> <a href="/collections/pulls">Shop cabinet pulls</a> <a href="/">here</a></main></body></html>`;

function site() {
  return fakeSite({
    [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nSitemap: ${U("/sitemap.xml")}\n` },
    [U("/sitemap.xml")]: { status: 200, contentType: "application/xml", body: `<urlset><url><loc>${U("/")}</loc></url><url><loc>${U("/collections/pulls")}</loc></url><url><loc>${U("/blog/how-to-choose-brass-pulls")}</loc></url></urlset>` },
    [U("/llms.txt")]: { status: 404, contentType: "text/plain", body: "" },
    [U("/")]: html(HOME),
    [U("/collections/pulls")]: html(COLLECTION),
    [U("/blog/how-to-choose-brass-pulls")]: html(ARTICLE),
    [U("/members")]: { status: 302, headers: { location: "/account/login?return=/members" } },
    [U("/account/login?return=/members")]: html(`<html>${head("Sign in to your Residence Example account", "/account/login")}<body><main><h1>Sign in</h1><p>Enter your email address and password to continue.</p></main></body></html>`),
  });
}

describe("extraction fields for checklists", () => {
  it("counts images without alt (decorative excluded), reads viewport, breadcrumbs, and generic anchors", () => {
    const home = extractPage(HOME, U("/"));
    expect(home.imagesTotal).toBe(3);
    expect(home.imagesMissingAlt).toBe(1);
    expect(home.viewport).toBe("width=device-width, initial-scale=1");
    expect(home.hasBreadcrumbNav).toBe(false);
    expect(home.genericAnchors).toEqual([{ href: U("/blog/how-to-choose-brass-pulls"), text: "read more" }]);
    const coll = extractPage(COLLECTION, U("/collections/pulls"));
    expect(coll.hasBreadcrumbNav).toBe(true);
    expect(coll.genericAnchors).toEqual([]);
    const art = extractPage(ARTICLE, U("/blog/how-to-choose-brass-pulls"));
    expect(art.genericAnchors.map((g) => g.text)).toEqual(["here"]);
    expect(art.imagesTotal).toBe(0);
    // noscript fallbacks and labelled links are not counted.
    const x = extractPage(`<html><body><noscript><img src="/a.png"></noscript><a href="/p" aria-label="Brass pull product page">More</a><div class="breadcrumbs"></div></body></html>`, U("/x"));
    expect(x.imagesTotal).toBe(0);
    expect(x.genericAnchors).toEqual([]);
    expect(x.hasBreadcrumbNav).toBe(true);
    expect(isGenericAnchorText("Read more →")).toBe(true);
    expect(isGenericAnchorText("Read more about brass finishes")).toBe(false);
  });
});

describe("checklists over a real crawl", () => {
  it("stores the new fields and measures access, structure, trust, and per-page items from them", async () => {
    const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId, { site_type: "saas" });
    const db = new Db(env.DB);
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site().fetch });
    const summary = await runCrawl(ctx);
    expect(summary.status).toBe("completed");

    const snap = await db.first<{ images_total: number; images_missing_alt: number; viewport_meta: string; breadcrumb_nav: number; generic_anchors_json: string }>(
      "SELECT s.images_total, s.images_missing_alt, s.viewport_meta, s.breadcrumb_nav, s.generic_anchors_json FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE p.url = ?",
      U("/"),
    );
    expect(snap).toMatchObject({ images_total: 3, images_missing_alt: 1, viewport_meta: "width=device-width, initial-scale=1", breadcrumb_nav: 0 });
    expect(JSON.parse(snap!.generic_anchors_json)).toEqual([{ href: U("/blog/how-to-choose-brass-pulls"), text: "read more" }]);

    const project = await projectRow(db, projectId);
    const geo = await getProjectChecklist(env, db, project, "geo", FIXED_NOW);
    const seo = await getProjectChecklist(env, db, project, "seo", FIXED_NOW);
    const s = (c: typeof geo, id: string) => c.items.find((i) => i.id === id)!;
    expect(geo.state).toBe("ready");
    // GPTBot and CCBot (training) blocked only: not a failure.
    expect(s(geo, "geo.access.ai_search_bots_allowed").status).toBe("met");
    expect(s(geo, "geo.access.ai_search_bots_allowed").summary).toMatch(/training crawlers blocked: GPTBot, CCBot/);
    expect(s(geo, "geo.access.sitemap_indexnow").status).toBe("met");
    // /members redirects to a sign-in path.
    expect(s(geo, "geo.access.no_login_walls").status).toBe("not_met");
    expect(s(geo, "geo.access.no_login_walls").evidence[0]?.url).toBe(U("/members"));
    expect(s(geo, "geo.access.key_text_in_html").status).toBe("met");
    expect(s(geo, "geo.structure.question_headings").status).toBe("met");
    expect(s(geo, "geo.trust.author_bio").status).toBe("met");
    expect(s(geo, "geo.trust.last_updated").status).toBe("met");
    expect(s(geo, "geo.trust.reputable_sources").status).toBe("met");
    // SaaS without a /pricing page in coverage.
    expect(s(geo, "geo.trust.public_pricing").status).toBe("not_met");
    expect(s(seo, "seo.on_page.image_alt").status).toBe("partial");
    expect(s(seo, "seo.technical.mobile_friendly").status).toBe("met");
    expect(s(seo, "seo.technical.sitemap_submitted").status).toBe("met");

    const page = await db.first<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND url = ?", projectId, U("/"));
    const pc = await getPageChecklist(env, db, project, page!.id, FIXED_NOW);
    const links = pc.items.find((i) => i.id === "page.publish_check.internal_links")!;
    expect(links.status).toBe("partial"); // generic "read more" anchor on the home page
    expect(links.evidence[0]?.label).toMatch(/Generic anchor "read more"/);
    expect(pc.items.find((i) => i.id === "page.details.alt_text")!.status).toBe("partial");
    expect(pc.items.find((i) => i.id === "page.publish_check.indexability")!.status).toBe("met");
  });
});
