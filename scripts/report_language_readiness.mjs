import { mkdir, writeFile } from "node:fs/promises";
import { languageReadinessStatus } from "../server/language-readiness.mjs";

const result = languageReadinessStatus();
const output = new URL("../work/model-evaluations/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("language-readiness.json", output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
const lines = ["# گزارش آمادگی زبان‌های نقشه", "",
  `- آزمون پایه: ${result.passed} پاسخ درست از ${result.samples} نمونه`,
  `- زمان دریافت مجموعهٔ مرجع: \`${result.referenceGeneratedAt}\``,
  "- درج خودکار: غیرفعال", "",
  "| زبان | آزمون پایه | پوشش واژه‌نامه در مرجع مستقل | دقت پاسخ‌های واژه‌نامه | باقی‌مانده برای مدل |",
  "|---|---:|---:|---:|---:|",
];
for (const language of result.languages) {
  lines.push(`| ${language.label} | ${language.passed}/${language.samples} | ${language.reference.resolved}/${language.reference.samples} | ${language.reference.precision}٪ | ${language.reference.unresolved} |`);
}
lines.push("", "این گزارش پوشش واژه‌نامه را می‌سنجد، نه کیفیت کامل مدل. موارد باقی‌مانده باید جداگانه با مدل آفلاین و داور ارزیابی شوند.", "");
await writeFile(new URL("language-readiness-fa.md", output), `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ passRate: result.passRate,
  languages: result.languages.map((item) => ({ language: item.language, reference: item.reference })) }, null, 2));
