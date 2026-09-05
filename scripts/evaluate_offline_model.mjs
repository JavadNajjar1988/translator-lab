import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { translateMapNamesWithProvider, translationQualityIssues } from "../server/translation-provider.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function normalized(value) {
  return String(value || "").normalize("NFKC").replaceAll("ي", "ی").replaceAll("ك", "ک")
    .replace(/[\u200c\s]+/g, " ").trim();
}

const inputPath = resolve(argument("--input", "work/approved-translations/evaluation-set.json"));
const limit = Math.max(1, Number.parseInt(argument("--limit", "300"), 10) || 300);
const batchSize = Math.max(1, Math.min(20, Number.parseInt(argument("--batch-size", "5"), 10) || 5));
const concurrency = Math.max(1, Math.min(4,
  Number.parseInt(argument("--concurrency", "1"), 10) || 1));
const provider = argument("--provider", process.env.TRANSLATION_PROVIDER || "local");
const outputPath = resolve(argument("--output", `work/model-evaluations/offline-${Date.now()}.json`));
process.env.LOCAL_TRANSLATION_BASE_URL ||= "http://127.0.0.1:1234/api/v1";
process.env.LOCAL_TRANSLATION_MODEL ||= "translator-local-qwen";
process.env.LOCAL_TRANSLATION_API_KEY ||= "lm-studio";

const fixture = JSON.parse(await readFile(inputPath, "utf8"));
const selected = fixture.entries.slice(0, Math.min(limit, fixture.entries.length));
const batches = [];
for (let offset = 0; offset < selected.length; offset += batchSize) {
  batches.push(selected.slice(offset, offset + batchSize));
}
const batchRows = new Array(batches.length);
let nextBatch = 0;
let completedItems = 0;
const startedAt = new Date();

async function evaluateBatch(batch, batchIndex) {
  const rows = [];
  const items = batch.map((entry) => ({ key: entry.key, sourceName: entry.source_name,
    layer: entry.layer || "", className: entry.class || "" }));
  const batchStartedAt = Date.now();
  try {
    const output = await translateMapNamesWithProvider(items, provider, { useMemory: false });
    const byKey = new Map(output.translations.map((entry) => [entry.key, entry]));
    for (const entry of batch) {
      const actual = byKey.get(entry.key)?.translatedName || "";
      const item = items.find((candidate) => candidate.key === entry.key);
      const issues = translationQualityIssues(item, actual);
      rows.push({ key: entry.key, sourceName: entry.source_name, sourceLanguage: entry.source_language,
        layer: entry.layer, className: entry.class,
        expected: entry.expected_translation, actual, exact: normalized(actual) === normalized(entry.expected_translation),
        qualityIssues: issues, error: null });
    }
  } catch (error) {
    for (const entry of batch) rows.push({ key: entry.key, sourceName: entry.source_name,
      sourceLanguage: entry.source_language, layer: entry.layer,
      className: entry.class, expected: entry.expected_translation, actual: "", exact: false, qualityIssues: [],
      error: error instanceof Error ? error.message : "evaluation_failed" });
  }
  batchRows[batchIndex] = rows;
  completedItems += batch.length;
  process.stdout.write(`ارزیابی ${completedItems} از ${selected.length}؛ زمان دسته ${Date.now() - batchStartedAt} میلی‌ثانیه\n`);
}

async function evaluationWorker() {
  while (nextBatch < batches.length) {
    const batchIndex = nextBatch;
    nextBatch += 1;
    await evaluateBatch(batches[batchIndex], batchIndex);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, evaluationWorker));
const rows = batchRows.flat();

const completed = rows.filter((row) => !row.error);
const exact = completed.filter((row) => row.exact).length;
const qualityPassed = completed.filter((row) => !row.qualityIssues.length).length;
const report = {
  formatVersion: 1, provider,
  model: provider === "madlad" ? process.env.MADLAD_TRANSLATION_MODEL || "google/madlad400-3b-mt"
    : process.env.LOCAL_TRANSLATION_MODEL,
  baseUrl: provider === "madlad" ? process.env.MADLAD_TRANSLATION_BASE_URL || "http://127.0.0.1:3007"
    : process.env.LOCAL_TRANSLATION_BASE_URL,
  input: inputPath, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  summary: { requested: selected.length, completed: completed.length, errors: rows.length - completed.length,
    exact, exactRate: completed.length ? exact / completed.length : 0, qualityPassed,
    qualityPassRate: completed.length ? qualityPassed / completed.length : 0 },
  mismatches: rows.filter((row) => !row.exact), rows,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n${JSON.stringify(report.summary)}\n`);
