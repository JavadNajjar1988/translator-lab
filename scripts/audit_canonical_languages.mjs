import { mkdir, writeFile } from "node:fs/promises";
import dataset from "../server/data/canonical-place-names.mjs";
import { auditCanonicalLanguages } from "../server/canonical-language-audit.mjs";

const outputDirectory = new URL("../work/model-evaluations/", import.meta.url);
const result = auditCanonicalLanguages(dataset);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL("canonical-language-coverage.json", outputDirectory), `${JSON.stringify(result, null, 2)}\n`, "utf8");

const lines = [
  "# ممیزی پوشش چندزبانهٔ نام‌های جغرافیایی",
  "",
  `- زمان تولید دادهٔ مبنا: \`${result.datasetGeneratedAt}\``,
  `- تعداد زبان‌ها: ${result.languageCount.toLocaleString("fa-IR")}`,
  `- تعداد مدخل‌های جغرافیایی: ${result.entryCount.toLocaleString("fa-IR")}`,
  `- تعداد نام‌های آزموده‌شده: ${result.totals.aliases.toLocaleString("fa-IR")}`,
  `- نرخ بازیابی ایمن: ${result.totals.safeRate.toLocaleString("fa-IR")}٪`,
  `- موارد بدون پاسخ قطعی: ${result.totals.unresolved.toLocaleString("fa-IR")}`,
  `- موارد دارای مقصد ناسازگار: ${result.totals.wrong.toLocaleString("fa-IR")}`,
  "",
  "این آزمون فقط نام‌های موجود در واژه‌نامه را می‌سنجد. نتیجهٔ آن برای نام‌های جدید، نام فروشگاه‌ها یا نام‌های محلیِ خارج از منابع مرجع قابل تعمیم نیست.",
  "",
  "| زبان | نام آزموده‌شده | بازیابی ایمن | نرخ | مبهم | بدون پاسخ | ناسازگار | خط غالب |",
  "|---|---:|---:|---:|---:|---:|---:|---|",
];
for (const row of result.languages) {
  const dominantScripts = Object.entries(row.scripts).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([script, count]) => `${script}: ${count.toLocaleString("fa-IR")}`).join("، ");
  lines.push(`| \`${row.language}\` | ${row.aliases.toLocaleString("fa-IR")} | ${row.safe.toLocaleString("fa-IR")} | ${row.safeRate.toLocaleString("fa-IR")}٪ | ${row.ambiguousValues.toLocaleString("fa-IR")} | ${row.unresolved.toLocaleString("fa-IR")} | ${row.wrong.toLocaleString("fa-IR")} | \`${dominantScripts}\` |`);
}
lines.push("", "## معیار اجازهٔ ترجمهٔ خودکار", "",
  "زبان فقط زمانی برای درج خودکار مجاز می‌شود که هم آزمون واژه‌نامه را بگذراند و هم روی مجموعه‌ای مستقل از داده‌های واقعی کارفرما ارزیابی شود. زبان‌های بدون مجموعهٔ مستقل باید در حالت پیش‌نمایش باقی بمانند.", "");
await writeFile(new URL("canonical-language-coverage-fa.md", outputDirectory), `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ totals: result.totals, languages: result.languageCount }, null, 2));
