import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const translationPath = resolve(argument("--translations",
  "work/model-evaluations/multilingual-regression-translations.json"));
const semanticPath = resolve(argument("--semantic",
  "work/model-evaluations/multilingual-regression-semantic.json"));
const outputPath = resolve(argument("--output",
  "work/model-evaluations/multilingual-regression-summary.json"));
const markdownPath = resolve(argument("--markdown",
  "work/model-evaluations/multilingual-regression-summary-fa.md"));
const translation = JSON.parse(await readFile(translationPath, "utf8"));
const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
const semanticByKey = new Map((semantic.rows || []).map((row) => [row.key, row]));
const labels = { ar: "عربی", he: "عبری", zh: "چینی", ja: "ژاپنی", ru: "روسی",
  de: "آلمانی", fr: "فرانسوی", es: "اسپانیایی" };

const rows = (translation.rows || []).map((row) => {
  const sourceLanguage = row.sourceLanguage || String(row.key || "").split(":", 1)[0] || "unknown";
  if (row.error) return { ...row, sourceLanguage, outcome: "error" };
  if (row.exact) return { ...row, sourceLanguage, outcome: "exact" };
  const judgement = semanticByKey.get(row.key);
  return { ...row, sourceLanguage, outcome: judgement?.decision || "invalid",
    semanticReason: judgement?.reasonCode || "missing_semantic_result" };
});

function metrics(items) {
  const count = (outcome) => items.filter((item) => item.outcome === outcome).length;
  const samples = items.length;
  const exact = count("exact");
  const equivalent = count("equivalent");
  const acceptable = exact + equivalent;
  return { samples, exact, equivalent, different: count("different"), uncertain: count("uncertain"),
    invalid: count("invalid"), errors: count("error"), acceptable,
    acceptableRate: samples ? Number((acceptable * 100 / samples).toFixed(2)) : 0 };
}

const languageCodes = [...new Set(rows.map((row) => row.sourceLanguage))];
const languages = languageCodes.map((language) => ({ language, label: labels[language] || language,
  ...metrics(rows.filter((row) => row.sourceLanguage === language)) }));
const report = { formatVersion: 1, mode: "balanced-multilingual-regression",
  generatedAt: new Date().toISOString(), translatorModel: translation.model,
  semanticJudgeModel: semantic.model, automaticApproval: false, summary: metrics(rows), languages, rows };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const lines = ["# آزمون بازگشتی چندزبانهٔ مترجم آفلاین", "",
  `- مدل مترجم: \`${report.translatorModel}\``,
  `- مدل ارزیاب: \`${report.semanticJudgeModel}\``,
  `- پاسخ قابل‌قبول: ${report.summary.acceptable} از ${report.summary.samples}`,
  `- نرخ قابل‌قبول: ${report.summary.acceptableRate} درصد`,
  "- درج خودکار: غیرفعال", "",
  "| زبان | نمونه | دقیق | هم‌ارز | اشتباه | نامطمئن | نامعتبر | خطا | نرخ قابل‌قبول |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...languages.map((item) => `| ${item.label} | ${item.samples} | ${item.exact} | ${item.equivalent} | ${item.different} | ${item.uncertain} | ${item.invalid} | ${item.errors} | ${item.acceptableRate}٪ |`),
  "", "این گزارش فقط یک دروازهٔ بازگشتی متوازن است. نتیجهٔ آن به‌تنهایی مجوز ثبت خودکار ترجمه‌های ساخته‌شده توسط مدل را صادر نمی‌کند.", ""];
await mkdir(dirname(markdownPath), { recursive: true });
await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`${outputPath}\n${markdownPath}\n${JSON.stringify(report.summary)}\n`);
