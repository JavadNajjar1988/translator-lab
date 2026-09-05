import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateSemanticEquivalence } from "../server/semantic-equivalence.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputPath = resolve(argument("--input",
  "work/model-evaluations/qwen3.5-cascade-rules-balanced-500.json"));
const outputPath = resolve(argument("--output", `work/model-evaluations/semantic-${Date.now()}.json`));
const concurrency = Math.max(1, Math.min(4,
  Number.parseInt(argument("--concurrency", "1"), 10) || 1));
const report = JSON.parse(await readFile(inputPath, "utf8"));
const selected = Array.isArray(report.falseAccepts) ? report.falseAccepts
  : Array.isArray(report.mismatches) ? report.mismatches.filter((row) => !row.error && row.actual)
    : [];
const rows = new Array(selected.length);
let nextRow = 0;
let completedRows = 0;
const startedAt = new Date();

async function evaluationWorker() {
  while (nextRow < selected.length) {
    const offset = nextRow;
    nextRow += 1;
    const row = selected[offset];
    const input = { key: row.key, sourceName: row.sourceName, sourceLanguage: row.sourceLanguage,
      layer: row.layer || "", className: row.className || row.class || "",
      reference: row.reference ?? row.expected, candidate: row.candidate ?? row.actual };
    const result = (await evaluateSemanticEquivalence([input])).get(row.key) || {
      decision: "invalid", reasonCode: "missing_output", provider: "semantic-judge",
    };
    rows[offset] = { ...input, ...result };
    completedRows += 1;
    process.stdout.write(`هم‌ارزی ${completedRows} از ${selected.length}\n`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, evaluationWorker));

const count = (decision) => rows.filter((row) => row.decision === decision).length;
const summary = { requested: rows.length, equivalent: count("equivalent"), different: count("different"),
  uncertain: count("uncertain"), invalid: count("invalid"),
  confirmedFalseAccepts: count("different"), conservativeReview: count("uncertain") + count("invalid") };
const output = { formatVersion: 1, mode: "reference-aware-evaluation", input: inputPath,
  model: process.env.SEMANTIC_JUDGE_MODEL?.trim() || "qwen3.5-9b", startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(), summary, rows };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n${JSON.stringify(summary)}\n`);
