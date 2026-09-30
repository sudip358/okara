import { describe, expect, it } from "vitest";
import { buildDownloadCsv, parseCsvFirstColumn, splitLines } from "@web/pages/redirects/csv";

describe("redirect map page: CSV import and download helpers", () => {
  it("imports the first column of a CSV, handling quotes, CRLF, BOM, and a header row", () => {
    const csv = '﻿Old URL,Notes\r\n"/old,one","a, b"\r\n/old-two,x\r\n\r\n"https://shop.example.com/say-""hi""",y\n/last';
    expect(parseCsvFirstColumn(csv)).toEqual(["/old,one", "/old-two", 'https://shop.example.com/say-"hi"', "/last"]);
    expect(parseCsvFirstColumn("/a\n/b\n")).toEqual(["/a", "/b"]);
    expect(parseCsvFirstColumn("")).toEqual([]);
  });

  it("splits pasted lines, trimming blanks", () => {
    expect(splitLines(" /a \r\n\n/b\r/c ")).toEqual(["/a", "/b", "/c"]);
  });

  it("download = server CSV (auto rows) + rows the user resolved, escaped, paths only, no duplicates or loops", () => {
    const server = "Redirect from,Redirect to\n/auto-old,/products/auto\n";
    const { csv, added } = buildDownloadCsv(server, [
      { from: "/review,one", to: "https://shop.example.com/products/chosen?variant=2" },
      { from: "/auto-old", to: "https://shop.example.com/products/other" }, // already exported
      { from: "/Same-Page/", to: "https://shop.example.com/same-page" }, // would loop
      { from: "/two", to: "not a url" },
    ]);
    expect(added).toBe(1);
    expect(csv).toBe('Redirect from,Redirect to\n/auto-old,/products/auto\n"/review,one",/products/chosen?variant=2\n');
    expect(buildDownloadCsv("", []).csv).toBe("Redirect from,Redirect to\n");
  });
});
