import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPlaceNames } from "../server/canonical-place-names.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputPath = resolve(argument("--input", "server/data/wikidata-language-acceptance.mjs"));
const outputPath = resolve(argument("--output", "work/model-evaluations/wikidata-model-evaluation.json"));
const corpus = (await import(pathToFileURL(inputPath).href)).default;

const pendingByLanguage = corpus.languages.map((language) => {
  const inputs = language.items.map((item, index) => ({ key: `${language.language}:${index}`,
    sourceName: item.sourceName, layer: item.layer, className: item.className }));
  const hits = canonicalPlaceNames.resolve(inputs);
  return { language: language.language, label: language.label, entries: language.items
    .filter((item, index) => !hits.has(`${language.language}:${index}`))
    .map((item) => ({ key: `${language.language}:${item.item}`, source_language: language.language,
      source_name: item.sourceName, expected_translation: item.expected,
      layer: item.layer, class: item.className, reference_id: item.item })) };
});

const entries = [];
const maximum = Math.max(...pendingByLanguage.map((language) => language.entries.length));
for (let index = 0; index < maximum; index += 1) {
  for (const language of pendingByLanguage) {
    if (language.entries[index]) entries.push(language.entries[index]);
  }
}
const output = { formatVersion: 1, generatedAt: new Date().toISOString(),
  sourceGeneratedAt: corpus.generatedAt, source: corpus.endpoint, targetLanguage: "fa",
  selection: "canonical-memory-misses-round-robin", languages: pendingByLanguage.map((language) => ({
    language: language.language, label: language.label, entries: language.entries.length })), entries };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ entries: entries.length, languages: output.languages }, null, 2));
