import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputPath = resolve(argument("--input", "work/model-evaluations/wikidata-qwen3.5-4b-native-smoke-80-v2.json"));
const outputPath = resolve(argument("--output", "work/model-evaluations/wikidata-qwen3.5-4b-semantic-input-80.json"));
const report = JSON.parse(await readFile(inputPath, "utf8"));
const falseAccepts = report.rows.filter((row) => !row.error && !row.exact).map((row) => ({
  key: row.key, sourceName: row.sourceName, layer: row.layer || "", className: row.class || "",
  reference: row.expected, candidate: row.actual,
}));
await writeFile(outputPath, `${JSON.stringify({ formatVersion: 1, source: inputPath, falseAccepts }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ candidates: falseAccepts.length, outputPath }, null, 2));
