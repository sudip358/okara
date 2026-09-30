#!/usr/bin/env node
// Replays eval/labels/*.jsonl through TypeSafe Jev and writes eval/results/<timestamp>.json.
// Requires TYPESAFE_API_KEY (and optionally TYPESAFE_MODEL). Without a key it exits with "setup required".
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@shared": join(root, "src/shared"), "@worker": join(root, "src/worker") },
});

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("Setup required: set TYPESAFE_API_KEY to run the evaluation. Nothing was written.");
  process.exit(2);
}

const { runEval, parseJsonl } = await jiti.import(join(root, "src/worker/eval/harness.ts"));
const { createTypeSafeProvider } = await jiti.import(join(root, "src/worker/providers/typesafe.ts"));

const labelsDir = join(root, "eval/labels");
const rows = readdirSync(labelsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => parseJsonl(readFileSync(join(labelsDir, f), "utf8")));

const recordedCalls = [];
const provider = createTypeSafeProvider({
  apiKey,
  model: process.env.TYPESAFE_MODEL,
  fetchImpl: (input, init) => fetch(input, init),
  calls: { async record(c) { recordedCalls.push(c); } },
});

const report = await runEval(rows, provider, { recordedCalls });
const outDir = join(root, "eval/results");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${report.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));

for (const [qid, s] of Object.entries(report.perQuestion)) {
  const pct = s.agreement.value === null ? "n/a" : `${(s.agreement.value * 100).toFixed(1)}%`;
  console.log(`${qid}: agreement ${pct} (${s.agreement.numerator}/${s.agreement.denominator}), p50 ${s.latencyMs.p50 ?? "n/a"} ms, p95 ${s.latencyMs.p95 ?? "n/a"} ms`);
}
console.log(`Calls: ${report.cost.calls}; unknown-cost calls: ${report.cost.unknownCostCalls}. Report: ${out}`);
