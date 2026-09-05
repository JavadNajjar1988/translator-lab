import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { judgeProperNameTranslations } from "../server/proper-name-judge.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function normalized(value) {
  return String(value || "").normalize("NFKC").replaceAll("ي", "ی").replaceAll("ك", "ک")
    .replace(/(?:\u0640|\u064e|\u0650|\u064f|\u064b|\u064d|\u064c|\u0652|\u0651)/gu, "")
    .replace(/[\u200c\s]+/g, " ").trim();
}

const inputPath = resolve(argument("--input", "work/model-evaluations/madlad400-first-100-single.json"));
const outputPath = resolve(argument("--output", `work/model-evaluations/judge-${Date.now()}.json`));
const limit = Math.max(1, Number.parseInt(argument("--limit", "100"), 10) || 100);
const batchSize = Math.max(1, Math.min(20, Number.parseInt(argument("--batch-size", "10"), 10) || 10));
process.env.PROPER_NAME_JUDGE_ENABLED = "true";
process.env.PROPER_NAME_JUDGE_BASE_URL ||= "http://127.0.0.1:1234/api/v1";
process.env.PROPER_NAME_JUDGE_MODEL ||= "qwen3.5-4b";

const translationReport = JSON.parse(await readFile(inputPath, "utf8"));
const selected = translationReport.rows.filter((row) => !row.error && row.actual).slice(0, limit);
const rows = [];
const startedAt = new Date();

for (let offset = 0; offset < selected.length; offset += batchSize) {
  const batch = selected.slice(offset, offset + batchSize);
  const sourceItems = batch.map((row) => ({ key: row.key, sourceName: row.sourceName,
    layer: row.layer || "", className: row.className || row.class || "" }));
  const candidates = batch.map((row) => ({ key: row.key, translatedName: row.actual }));
  const batchStartedAt = Date.now();
  const result = await judgeProperNameTranslations(sourceItems, candidates);
  if (!result || result.status === "unavailable") {
    throw new Error(`داور محلی برای دستهٔ ${offset + 1} تا ${offset + batch.length} در دسترس نبود.`);
  }
  for (const row of batch) {
    const judgement = result?.judgements.get(row.key) || { decision: "invalid", suggestedName: row.actual,
      reasonCode: "missing_judge_result" };
    const referenceExact = normalized(row.actual) === normalized(row.expected);
    const flagged = ["correct", "reject"].includes(judgement.decision);
    rows.push({ key: row.key, sourceName: row.sourceName, layer: row.layer,
      className: row.className || row.class || "", reference: row.expected, candidate: row.actual,
      referenceExact, ...judgement, flagged,
      suggestionExact: normalized(judgement.suggestedName) === normalized(row.expected) });
  }
  process.stdout.write(`داوری ${Math.min(offset + batch.length, selected.length)} از ${selected.length}؛ زمان دسته ${Date.now() - batchStartedAt} میلی‌ثانیه\n`);
}

const valid = rows.filter((row) => row.decision !== "invalid");
const exact = valid.filter((row) => row.referenceExact);
const mismatched = valid.filter((row) => !row.referenceExact);
const flagged = valid.filter((row) => row.flagged);
const correctlyFlagged = mismatched.filter((row) => row.flagged);
const falseAccepted = mismatched.filter((row) => !row.flagged);
const falseFlagged = exact.filter((row) => row.flagged);
const correctedExactly = correctlyFlagged.filter((row) => row.suggestionExact);
const summary = {
  requested: selected.length, valid: valid.length, invalid: rows.length - valid.length,
  referenceExact: exact.length, referenceMismatch: mismatched.length,
  detectedMismatches: correctlyFlagged.length,
  mismatchDetectionRate: mismatched.length ? correctlyFlagged.length / mismatched.length : null,
  falseAccepts: falseAccepted.length,
  falseAcceptRate: mismatched.length ? falseAccepted.length / mismatched.length : null,
  falseFlags: falseFlagged.length,
  exactAcceptanceRate: exact.length ? (exact.length - falseFlagged.length) / exact.length : null,
  flagPrecision: flagged.length ? correctlyFlagged.length / flagged.length : null,
  exactCorrections: correctedExactly.length,
  exactCorrectionRate: correctlyFlagged.length ? correctedExactly.length / correctlyFlagged.length : null,
};
const report = { formatVersion: 1, mode: "shadow", model: process.env.PROPER_NAME_JUDGE_MODEL,
  baseUrl: process.env.PROPER_NAME_JUDGE_BASE_URL, input: inputPath,
  startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), summary,
  falseAccepts: falseAccepted, falseFlags: falseFlagged, rows };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n${JSON.stringify(summary)}\n`);
