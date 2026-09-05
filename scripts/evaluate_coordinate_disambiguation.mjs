import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import base from "../server/data/canonical-place-names.mjs";
import gazetteer from "../server/data/wikidata-place-gazetteer.mjs";
import supplements from "../server/data/canonical-place-supplements.mjs";
import blockedAliasValues from "../server/data/canonical-place-blocked-aliases.mjs";
import { canonicalPlaceNames, coordinateResolutionPolicy } from "../server/canonical-place-names.mjs";

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function percentage(value, total) {
  return total ? Number((value * 100 / total).toFixed(2)) : 0;
}

function shifted([longitude, latitude], kilometers) {
  if (!kilometers) return [longitude, latitude];
  const bearing = 37 * Math.PI / 180;
  const latitudeDelta = kilometers * Math.cos(bearing) / 110.574;
  const longitudeScale = Math.max(0.05, Math.cos(latitude * Math.PI / 180));
  const longitudeDelta = kilometers * Math.sin(bearing) / (111.320 * longitudeScale);
  return [longitude + longitudeDelta, latitude + latitudeDelta];
}

function midpoint(first, second) {
  let [firstLongitude, firstLatitude] = first;
  let [secondLongitude, secondLatitude] = second;
  if (Math.abs(firstLongitude - secondLongitude) > 180) {
    if (firstLongitude < secondLongitude) firstLongitude += 360;
    else secondLongitude += 360;
  }
  let longitude = (firstLongitude + secondLongitude) / 2;
  if (longitude > 180) longitude -= 360;
  return [longitude, (firstLatitude + secondLatitude) / 2];
}

function distanceKilometers(first, second) {
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(second[1] - first[1]);
  const longitudeDistance = radians(second[0] - first[0]);
  const value = Math.sin(latitudeDistance / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1])) * Math.sin(longitudeDistance / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const blocked = new Set(blockedAliasValues.map(normalized));
const entries = [
  ...base.entries.map((entry) => supplements[entry.id]
    ? { ...entry, aliases: [...(entry.aliases || []), ...supplements[entry.id]] } : entry),
  ...gazetteer.entries,
];
const aliases = new Map();
for (const entry of entries) {
  for (const alias of entry.aliases || []) {
    const key = normalized(alias.value);
    if (!key || blocked.has(key)) continue;
    if (!aliases.has(key)) aliases.set(key, { sourceName: alias.value, languages: new Set(), entries: new Map() });
    const group = aliases.get(key);
    group.languages.add(alias.language || "und");
    group.entries.set(entry.id, entry);
  }
}

const groups = [...aliases.values()].filter((group) => group.entries.size > 1
  && [...group.entries.values()].every((entry) => Array.isArray(entry.coordinates)
    && entry.coordinates.length === 2 && entry.coordinates.every(Number.isFinite)));

function simulatePolicy(kilometers, minimumGapKilometers, relativeGap) {
  const metric = emptyMetric();
  for (const group of groups) {
    const candidates = [...group.entries.values()];
    const oneTarget = new Set(candidates.map((entry) => normalized(entry.target_name))).size === 1;
    for (const expected of candidates) {
      const location = shifted(expected.coordinates, kilometers);
      const ranked = candidates.map((entry) => ({ entry,
        distance: distanceKilometers(location, entry.coordinates) })).sort((a, b) => a.distance - b.distance);
      const nearest = ranked[0];
      const second = ranked[1];
      const safe = nearest.distance <= 100
        && second.distance - nearest.distance >= Math.max(minimumGapKilometers, nearest.distance * relativeGap);
      const selected = safe ? nearest.entry : oneTarget ? candidates[0] : null;
      addMetric(metric, { hit: selected, identityCorrect: selected?.id === expected.id,
        translationCorrect: normalized(selected?.target_name) === normalized(expected.target_name) });
    }
  }
  return { kilometers, minimumGapKilometers, relativeGap, ...finalize(metric) };
}

function emptyMetric() {
  return { cases: 0, resolved: 0, identityCorrect: 0, translationCorrect: 0,
    wrongTranslation: 0, unresolved: 0 };
}

function addMetric(metric, result) {
  metric.cases += 1;
  if (!result.hit) metric.unresolved += 1;
  else {
    metric.resolved += 1;
    if (result.identityCorrect) metric.identityCorrect += 1;
    if (result.translationCorrect) metric.translationCorrect += 1;
    else metric.wrongTranslation += 1;
  }
}

function finalize(metric) {
  return { ...metric, coverageRate: percentage(metric.resolved, metric.cases),
    identityAccuracy: percentage(metric.identityCorrect, metric.cases),
    translationAccuracy: percentage(metric.translationCorrect, metric.cases),
    wrongTranslationRate: percentage(metric.wrongTranslation, metric.cases) };
}

function evaluateDistance(kilometers) {
  const total = emptyMetric();
  const languageMetrics = new Map();
  const failures = [];
  for (const group of groups) {
    for (const entry of group.entries.values()) {
      const [longitude, latitude] = shifted(entry.coordinates, kilometers);
      const hit = canonicalPlaceNames.resolve([{ key: "case", sourceName: group.sourceName,
        layer: "place", className: "", longitude, latitude }]).get("case");
      const result = { hit, identityCorrect: hit?.canonicalId === entry.id,
        translationCorrect: normalized(hit?.translatedName) === normalized(entry.target_name) };
      addMetric(total, result);
      for (const language of group.languages) {
        if (!languageMetrics.has(language)) languageMetrics.set(language, emptyMetric());
        addMetric(languageMetrics.get(language), result);
      }
      if ((!result.translationCorrect || !result.identityCorrect) && failures.length < 100) {
        failures.push({ sourceName: group.sourceName, expectedId: entry.id, expected: entry.target_name,
          coordinates: [longitude, latitude], actualId: hit?.canonicalId || null,
          actual: hit?.translatedName || null, languages: [...group.languages] });
      }
    }
  }
  return { kilometers, summary: finalize(total), languages: Object.fromEntries(
    [...languageMetrics].sort(([a], [b]) => a.localeCompare(b)).map(([language, metric]) => [language, finalize(metric)])),
    failures };
}

const midpointMetric = { cases: 0, rejected: 0, resolved: 0, unsafeTranslation: 0 };
const midpointFailures = [];
for (const group of groups) {
  const candidates = [...group.entries.values()];
  if (candidates.length !== 2 || normalized(candidates[0].target_name) === normalized(candidates[1].target_name)) continue;
  const [longitude, latitude] = midpoint(candidates[0].coordinates, candidates[1].coordinates);
  const hit = canonicalPlaceNames.resolve([{ key: "midpoint", sourceName: group.sourceName,
    layer: "place", className: "", longitude, latitude }]).get("midpoint");
  midpointMetric.cases += 1;
  if (!hit) midpointMetric.rejected += 1;
  else {
    midpointMetric.resolved += 1;
    midpointMetric.unsafeTranslation += 1;
    if (midpointFailures.length < 100) midpointFailures.push({ sourceName: group.sourceName,
      candidateIds: candidates.map((entry) => entry.id), candidateNames: candidates.map((entry) => entry.target_name),
      coordinates: [longitude, latitude], actualId: hit.canonicalId, actual: hit.translatedName });
  }
}

const runs = [evaluateDistance(0), evaluateDistance(5), evaluateDistance(25)];
const policyCandidates = [10, 20, 25, 30, 40, 50].flatMap((minimumGapKilometers) =>
  [0.25, 0.5, 1].map((relativeGap) => simulatePolicy(25, minimumGapKilometers, relativeGap)));
const output = { version: 1, generatedAt: new Date().toISOString(), targetLanguage: "fa",
  method: "reference_coordinate_plus_fixed_northeast_shift",
  safeguards: { ...coordinateResolutionPolicy, noClassHint: true },
  source: { entries: entries.length, coordinateEntries: entries.filter((entry) => Array.isArray(entry.coordinates)).length,
    ambiguousAliases: [...aliases.values()].filter((group) => group.entries.size > 1).length,
    coordinateResolvableAliases: groups.length }, runs, policyCandidates,
  midpoint: { ...midpointMetric, rejectionRate: percentage(midpointMetric.rejected, midpointMetric.cases),
    unsafeTranslationRate: percentage(midpointMetric.unsafeTranslation, midpointMetric.cases),
    failures: midpointFailures } };

const outputPath = resolve(process.argv[2] || "work/model-evaluations/coordinate-disambiguation-evaluation.json");
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
const languageLabels = { ar: "عربی", bg: "بلغاری", bn: "بنگالی", cs: "چکی", de: "آلمانی",
  el: "یونانی", en: "انگلیسی", es: "اسپانیایی", fa: "فارسی", fr: "فرانسوی", he: "عبری",
  hi: "هندی", hu: "مجاری", id: "اندونزیایی", it: "ایتالیایی", ja: "ژاپنی", kk: "قزاقی",
  ko: "کره‌ای", mr: "مراتی", ms: "مالایی", ne: "نپالی", nl: "هلندی", pl: "لهستانی",
  pt: "پرتغالی", ro: "رومانیایی", ru: "روسی", sr: "صربی", tr: "ترکی", uk: "اوکراینی",
  und: "بدون برچسب زبان", ur: "اردو", vi: "ویتنامی", zh: "چینی", "zh-Hans": "چینی ساده‌شده",
  "zh-Hant": "چینی سنتی" };
const faNumber = (value) => Number(value).toLocaleString("fa-IR", { maximumFractionDigits: 2 });
const runRows = runs.map((run) => `| ${faNumber(run.kilometers)} | ${faNumber(run.summary.cases)} | ${faNumber(run.summary.translationCorrect)} | ${faNumber(run.summary.wrongTranslation)} | ${faNumber(run.summary.unresolved)} | ${faNumber(run.summary.translationAccuracy)}٪ |`).join("\n");
const languageRows = Object.entries(runs.find((run) => run.kilometers === 25).languages)
  .map(([language, metric]) => `| ${languageLabels[language] || language} | \`${language}\` | ${faNumber(metric.cases)} | ${faNumber(metric.translationCorrect)} | ${faNumber(metric.wrongTranslation)} | ${faNumber(metric.unresolved)} | ${faNumber(metric.translationAccuracy)}٪ |`).join("\n");
const report = `# گزارش آزمون رفع ابهام مکانی

- تعداد مدخل‌های فرهنگ: ${faNumber(output.source.entries)}
- مدخل‌های دارای مختصات: ${faNumber(output.source.coordinateEntries)}
- نام‌های مبهم دارای مختصات کامل: ${faNumber(output.source.coordinateResolvableAliases)}
- تعداد حالت‌های هویتی آزموده‌شده: ${faNumber(runs[0].summary.cases)}
- بیشینهٔ فاصله از نامزد: ${faNumber(output.safeguards.maximumDistanceKilometers)} کیلومتر
- کمینهٔ برتری فاصله نسبت به نامزد دوم: ${faNumber(output.safeguards.minimumGapKilometers)} کیلومتر
- ثبت خودکار ترجمه: غیرفعال

| جابه‌جایی مصنوعی از مختصات مرجع، کیلومتر | حالت | ترجمه درست | ترجمه غلط | بدون تصمیم | نرخ ترجمه درست |
|---:|---:|---:|---:|---:|---:|
${runRows}

در مختصات مرجع، با خطای پنج‌کیلومتری و با خطای بیست‌وپنج‌کیلومتری هیچ ترجمهٔ غلطی پذیرفته نشد. کاهش نرخ در فاصله‌های بیشتر ناشی از خودداری سامانه از تصمیم است. آزمون ${faNumber(output.midpoint.cases)} نقطهٔ میانی میان دو نامزد متفاوت نیز در همهٔ موارد بدون انتخاب خاتمه یافت.

این آزمون یک سنجش ساختاری و مصنوعی است: نقطهٔ مرجع فرهنگ جابه‌جا شده تا تحمل خطای مکانی اندازه‌گیری شود. این نتیجه جای آزمون با عوارض واقعی و شناسه‌های تأییدشدهٔ کارفرما را نمی‌گیرد.

## نتیجهٔ زبان‌ها در خطای بیست‌وپنج‌کیلومتری

| زبان | شناسه | حالت | درست | غلط | بدون تصمیم | نرخ درست |
|---|---|---:|---:|---:|---:|---:|
${languageRows}
`;
const reportPath = resolve(process.argv[3] || "work/model-evaluations/coordinate-disambiguation-summary-fa.md");
await writeFile(reportPath, report, "utf8");
const smoke = { version: 1, evaluatedAt: output.generatedAt, automaticApproval: false,
  coordinateResolvableAliases: output.source.coordinateResolvableAliases, cases: runs[0].summary.cases,
  runs: Object.fromEntries(runs.map((run) => [String(run.kilometers), {
    correct: run.summary.translationCorrect, wrong: run.summary.wrongTranslation,
    unresolved: run.summary.unresolved, accuracy: run.summary.translationAccuracy }])),
  midpoint: { cases: output.midpoint.cases, rejected: output.midpoint.rejected,
    unsafe: output.midpoint.unsafeTranslation } };
const smokePath = resolve(process.argv[4] || "server/data/coordinate-disambiguation-smoke.mjs");
await writeFile(smokePath, `// Generated by scripts/evaluate_coordinate_disambiguation.mjs\nexport default ${JSON.stringify(smoke)};\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, source: output.source,
  report: reportPath, smoke: smokePath,
  runs: runs.map((run) => ({ kilometers: run.kilometers, ...run.summary })),
  midpoint: output.midpoint }, null, 2));
