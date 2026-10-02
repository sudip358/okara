/**
 * Synthetic Google Sheets fixtures for the Import tests. Header rows match the owner's tab headers exactly; every
 * value below is invented (no data from the owner's sheet). Response bodies follow the documented shapes:
 *   spreadsheets.get  -> Spreadsheet { spreadsheetId, properties{title}, sheets[{properties{sheetId,title,index,sheetType,gridProperties}}] }
 *   values.get        -> ValueRange { range, majorDimension, values } (trailing empty cells/rows omitted: ragged rows)
 * (developers.google.com/workspace/sheets/api/reference/rest, read 2026-10-02).
 */
export const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz";
export const SPREADSHEET_TITLE = "Example Campaign Sheet + Index";

export const AI_QUESTIONS_HEADERS = [
  "Question",
  "Done",
  "Residence supply (position)",
  "Lumens (position)",
  "Forbes & lomax (position)",
  "Buster + punch (position)",
  "Rejuvenation (position)",
  "Competitors",
];
export const COMPETITORS_HEADERS = [
  "Competing Domains",
  "Notes",
  "Assigned to",
  "DA",
  "Traffic Pages",
  "Organic Traffic",
  "Organic Keywords",
  "Referring Domains (Dofollow)",
  "Homepage RD (Dofollow)",
  "Homepage Ratio",
  "Referring Domains Internal",
  "Total Internal RD Ratio",
];
export const BLOG_HUB_HEADERS = ["Date", "Source Article URL", "Target URL", "Anchor", "Method", "Hub", "Status"];

export const aiQuestionRows = (): string[][] => [
  AI_QUESTIONS_HEADERS,
  ["What are the best brass wall sconces for a hallway?", "Yes", "3", "1", "", "2"],
  ["How do I pick a pendant light size for a kitchen island", "", "", "4", "2"],
  ["Which lighting brands sell solid brass cabinet pulls?", "Yes"],
  ["What are the best brass wall sconces for a hallway", "dup"], // duplicate (punctuation differs)
  [""],
  ["Is Lumens better than Residence Supply for pendants?", "", "", "1"], // names tracked brands -> reputation
];

export const competitorRows = (): string[][] => [
  COMPETITORS_HEADERS,
  ["shop.example.com", "Our own site", "", "40"], // own domain -> skipped
  ["lumens.example", "Big catalogue", "Sam", "71", "1,200", "250,000", "90,000", "8,100", "1,900", "23%", "300", "0.04"],
  ["rejuvenation.example", "", "Ana", "68", "900", "120,000"],
  ["not a domain"],
  ["https://www.forbes-lomax.example/", "UK switches", "", "45"],
];

export const blogHubRows = (): string[][] => [
  BLOG_HUB_HEADERS,
  ["2026-09-01", "https://shop.example.com/blogs/news/brass-care", "https://shop.example.com/products/brass-pull", "solid brass pull", "Manual", "Brass hub", "Live"],
  ["2026-09-02", "/products/brass-pull", "/blogs/news/brass-care", "care for brass", "Manual", "Brass hub", "Live"],
  ["2026-09-03", "https://elsewhere.example/a", "https://shop.example.com/b", "x"], // off-site -> skipped
];

export interface FakeTab {
  sheetId: number;
  title: string;
  rows: string[][];
}

/** spreadsheets.get response for the given tabs (fields mask applied by the caller is ignored, as a real server would honour it). */
export function spreadsheetResponse(tabs: FakeTab[], title = SPREADSHEET_TITLE) {
  return {
    spreadsheetId: SPREADSHEET_ID,
    properties: { title },
    sheets: tabs.map((t, index) => ({
      properties: { sheetId: t.sheetId, title: t.title, index, sheetType: "GRID", gridProperties: { rowCount: Math.max(1000, t.rows.length), columnCount: 26 } },
    })),
  };
}

/** values.get response: trailing empty cells and rows removed like the real API. */
export function valuesResponse(tab: FakeTab, rangeA1: string) {
  const values = tab.rows.map((r) => {
    const out = [...r];
    while (out.length && out[out.length - 1] === "") out.pop();
    return out;
  });
  while (values.length && values[values.length - 1]!.length === 0) values.pop();
  return { range: rangeA1, majorDimension: "ROWS", values };
}
