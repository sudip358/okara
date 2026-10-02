/** Import shared helpers: CSV parsing edge cases, BOM decoding, tables, header -> destination auto-mapping, keys. */
import { describe, expect, it } from "vitest";
import {
  MAX_CELL_CHARS,
  countsSentence,
  decodeCsvBytes,
  detectDelimiter,
  extractSpreadsheetId,
  linkKey,
  numericCell,
  parseCsv,
  positionHeaderName,
  promptKey,
  requiredColumns,
  suggestDestination,
  toTable,
  type CompetitorsMapping,
  type LinksMapping,
  type PromptsMapping,
} from "@shared/import";
import { AI_QUESTIONS_HEADERS, BLOG_HUB_HEADERS, COMPETITORS_HEADERS } from "./fixtures/sheets";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, delimiters and line breaks inside quoted cells", () => {
    const csv = 'a,b,c\n"x, y","say ""hi""","line1\nline2"\n1,2,3';
    expect(parseCsv(csv).rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
      ["1", "2", "3"],
    ]);
  });

  it("accepts CRLF, LF and lone CR row endings and a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4\n5,6\n").rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("keeps empty cells and a final quoted empty cell", () => {
    expect(parseCsv('a,,c\n,"",').rows).toEqual([["a", "", "c"], ["", "", ""]]);
  });

  it("keeps a stray quote inside an unquoted cell literally", () => {
    expect(parseCsv('12" pendant,ok').rows).toEqual([['12" pendant', "ok"]]);
  });

  it("detects tab-separated cells pasted from Google Sheets and semicolon CSV", () => {
    expect(detectDelimiter("Question\tDone\nA\tYes")).toBe("\t");
    expect(parseCsv("Question\tDone\nWhat, exactly?\tYes").rows).toEqual([["Question", "Done"], ["What, exactly?", "Yes"]]);
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter('"a;b",c\n1,2')).toBe(",");
  });

  it("strips a UTF-8 BOM in text and decodes UTF-8 / UTF-16 LE / UTF-16 BE byte order marks", () => {
    expect(parseCsv("﻿Question,Done\nA,B").rows[0]).toEqual(["Question", "Done"]);
    const text = "Question,Done\nÜber Lämpchen?,ja";
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeCsvBytes(utf8)).toBe(text);
    const le = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff;
    le[1] = 0xfe;
    const be = new Uint8Array(2 + text.length * 2);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      le[2 + i * 2] = code & 0xff;
      le[3 + i * 2] = code >> 8;
      be[2 + i * 2] = code >> 8;
      be[3 + i * 2] = code & 0xff;
    }
    expect(decodeCsvBytes(le)).toBe(text);
    expect(decodeCsvBytes(be)).toBe(text);
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toBe(text);
  });

  it("caps rows (truncated flag) and clips very long cells", () => {
    const many = ["h", ...Array.from({ length: 50 }, (_, i) => String(i))].join("\n");
    const r = parseCsv(many, { maxRows: 11 });
    expect(r.rows).toHaveLength(11);
    expect(r.truncated).toBe(true);
    expect(parseCsv(many).truncated).toBe(false);
    const long = parseCsv(`h\n${"x".repeat(MAX_CELL_CHARS + 500)}`);
    expect(long.rows[1]![0]!.length).toBe(MAX_CELL_CHARS);
  });
});

describe("toTable", () => {
  it("uses the first non-empty row as headers, names empty/duplicate headers, drops blank rows, pads ragged rows", () => {
    const t = toTable([[""], ["Question", "", "Notes", "Notes", ""], ["Q1", "x"], [], ["", "", ""], ["Q2", "y", "n", "m", "extra", "more"]]);
    expect(t.headers).toEqual(["Question", "Column 2", "Notes", "Notes (2)"]);
    expect(t.rows).toEqual([
      ["Q1", "x", "", ""],
      ["Q2", "y", "n", "m"],
    ]);
    expect(t.rowNumbers).toEqual([3, 6]);
  });

  it("removes control characters from cells", () => {
    expect(toTable([["h"], ["a\u0000b\u0007c"]]).rows[0]).toEqual(["abc"]);
  });
});

describe("suggestDestination (owner's exact headers)", () => {
  it("AI Questions -> GEO prompts with the (position) and Competitors columns as notes", () => {
    const s = suggestDestination("AI Questions", AI_QUESTIONS_HEADERS);
    expect(s.destination).toBe("geo_prompts");
    const m = s.mapping as PromptsMapping;
    expect(m.question).toBe("Question");
    expect(m.done).toBe("Done");
    expect(m.notes).toEqual(AI_QUESTIONS_HEADERS.slice(2));
    expect(requiredColumns("geo_prompts", m)).toEqual(["Question"]);
  });

  it("04 - Competitors -> competitors with metrics", () => {
    const s = suggestDestination("04 - Competitors", COMPETITORS_HEADERS);
    expect(s.destination).toBe("competitors");
    const m = s.mapping as CompetitorsMapping;
    expect(m).toMatchObject({ domain: "Competing Domains", notes: "Notes", assignedTo: "Assigned to" });
    expect(m.metrics).toEqual(COMPETITORS_HEADERS.slice(3));
  });

  it("Blog Hub Drops -> implemented links", () => {
    const s = suggestDestination("Blog Hub Drops", BLOG_HUB_HEADERS);
    expect(s.destination).toBe("implemented_links");
    expect(s.mapping as LinksMapping).toEqual({ source: "Source Article URL", target: "Target URL", anchor: "Anchor", date: "Date", method: "Method", hub: "Hub", status: "Status" });
  });

  it("technical audit and internal-link tabs -> reference only; research tabs -> context document", () => {
    for (const tab of ["Titles", "H1", "Meta", "30x", "40x", "Indexed"]) expect(suggestDestination(tab, ["Address", "Status Code"]).destination).toBe("reference");
    for (const tab of ["InternalLink_Overview", "InternalLinkList_Page", "Orphaned Pages"]) expect(suggestDestination(tab, ["Address", "Inlinks"]).destination).toBe("reference");
    for (const tab of ["Content Decay", "Content/Keyword Gap", "Proposed Collections", "Blogs Plan", "10 - Cluster Content", "RS vs Lumens", "AI Citation Traffic", "Reporting Sheet"]) {
      const s = suggestDestination(tab, ["URL", "Clicks", "Change"]);
      expect(s.destination).toBe("context_doc");
      expect(s.mapping).toMatchObject({ title: tab, columns: ["URL", "Clicks", "Change"] });
    }
  });
});

describe("keys and helpers", () => {
  it("normalizes prompts, links, spreadsheet ids and numbers", () => {
    expect(promptKey("  What are the BEST  sconces? ")).toBe(promptKey("what are the best sconces"));
    expect(linkKey("https://www.shop.example.com/a/?utm_source=x#top", "https://shop.example.com/b", " Solid  Brass ")).toBe(linkKey("https://shop.example.com/a", "https://shop.example.com/b/", "solid brass"));
    expect(extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1wkTB0D9hTQb1Nl_gbBMiC5uj4dGsNFzn_PD0Q3Ks4pM/edit#gid=0")).toBe("1wkTB0D9hTQb1Nl_gbBMiC5uj4dGsNFzn_PD0Q3Ks4pM");
    expect(extractSpreadsheetId("not a sheet")).toBeNull();
    expect(numericCell("1,234")).toBe(1234);
    expect(numericCell("23%")).toBe(23);
    expect(numericCell("n/a")).toBeNull();
    expect(positionHeaderName("Buster + punch (position)")).toBe("Buster + punch");
    expect(positionHeaderName("Competitors")).toBeNull();
    expect(countsSentence({ add: 42, skip: 3 }, { one: "prompt", many: "prompts" })).toBe("42 prompts new, 3 skipped");
  });
});
