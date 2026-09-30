# Evaluation set and benchmark harness

Required by `[A5]` and `[A13]` in `docs/build-kit.md`: no speed, cost, or quality claim ships without these numbers,
and Jev thresholds stay labelled "engineering defaults" until fitted here.

## Labelled set (`eval/labels/*.jsonl`)

One JSON object per line:

```json
{"id": "seo-intent-001", "question_id": "seo.query_intent", "question_version": "<hash>", "state": {...}, "human_answer": "transactional", "source": "manual", "labelled_by": "reviewer-initials", "labelled_at": "2026-10-01"}
```

Rows come from two places: hand-labelled fixtures and "Disagree" submissions in the app (`judgment_feedback`, exported via
`GET /api/projects/:pid/export`). Keep at least 30 rows per question before fitting thresholds.

## Benchmark (`npm run eval`)

`scripts/eval.mjs` (running `src/worker/eval/harness.ts`) replays every labelled row through the configured DecisionProvider and reports per question:
agreement with the human label, agreement by tier (act/flag/drop), latency p50/p95, and cost per call (actual, estimate,
or unknown). Results are written to `eval/results/<date>.json`. Without `TYPESAFE_API_KEY` the script exits with
"setup required" and writes nothing.
