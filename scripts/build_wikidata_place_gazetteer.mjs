import { writeFile } from "node:fs/promises";
import acceptance from "../server/data/wikidata-language-acceptance.mjs";

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function aliasKey(language, value) {
  return `${language}:${normalized(value)}`;
}

function sparqlLiteral(value, language) {
  return `${JSON.stringify(String(value))}@${language}`;
}

async function uniqueCityCounts(language, items, attempt = 1) {
  const values = items.map((item) => sparqlLiteral(item.sourceName, language)).join(" ");
  const query = `SELECT ?source (COUNT(DISTINCT ?item) AS ?count) WHERE {
    VALUES ?source { ${values} }
    ?item wdt:P31 wd:Q515; rdfs:label ?source.
  } GROUP BY ?source`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref?.();
  try {
    const response = await fetch(acceptance.endpoint, { method: "POST",
      headers: { accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "TranslatorLab-Gazetteer/0.1" }, signal: controller.signal,
      body: new URLSearchParams({ query, format: "json" }) });
    if (!response.ok) throw new Error(`wikidata_${response.status}`);
    const payload = await response.json();
    return new Map((payload.results?.bindings || []).map((binding) => [
      aliasKey(language, binding.source?.value), Number.parseInt(binding.count?.value || "0", 10),
    ]));
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    return uniqueCityCounts(language, items, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

function parsePoint(value) {
  const match = /^Point\(([-+\d.eE]+)\s+([-+\d.eE]+)\)$/.exec(String(value || ""));
  if (!match) return null;
  const coordinates = [Number(match[1]), Number(match[2])];
  return coordinates.every(Number.isFinite) ? coordinates : null;
}

async function coordinatesForEntities(entityIds, attempt = 1) {
  const values = entityIds.map((id) => `wd:${id}`).join(" ");
  const query = `SELECT ?item (SAMPLE(?point) AS ?coordinate) WHERE {
    VALUES ?item { ${values} }
    OPTIONAL { ?item wdt:P625 ?point. }
  } GROUP BY ?item`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref?.();
  try {
    const response = await fetch(acceptance.endpoint, { method: "POST",
      headers: { accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "TranslatorLab-Gazetteer/0.2" }, signal: controller.signal,
      body: new URLSearchParams({ query, format: "json" }) });
    if (!response.ok) throw new Error(`wikidata_coordinates_${response.status}`);
    const payload = await response.json();
    return new Map((payload.results?.bindings || []).map((binding) => [
      binding.item?.value?.split("/").pop(), parsePoint(binding.coordinate?.value),
    ]).filter(([, coordinates]) => coordinates));
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    return coordinatesForEntities(entityIds, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

const uniqueness = new Map();
for (const language of acceptance.languages || []) {
  for (let offset = 0; offset < language.items.length; offset += 40) {
    const batch = language.items.slice(offset, offset + 40);
    const counts = await uniqueCityCounts(language.language, batch);
    for (const item of batch) uniqueness.set(aliasKey(language.language, item.sourceName),
      counts.get(aliasKey(language.language, item.sourceName)) || 0);
    process.stdout.write(`${language.language}: ${Math.min(offset + batch.length, language.items.length)} از ${language.items.length}\n`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const grouped = new Map();
let excludedAmbiguous = 0;
let excludedMissing = 0;
for (const language of acceptance.languages || []) {
  for (const item of language.items || []) {
    const count = uniqueness.get(aliasKey(language.language, item.sourceName)) || 0;
    if (count !== 1) {
      if (count > 1) excludedAmbiguous += 1; else excludedMissing += 1;
      continue;
    }
    if (!grouped.has(item.item)) grouped.set(item.item, {
      id: `wikidata:${item.item}`, kind: "city", target_name: item.expected, aliases: [],
    });
    const entry = grouped.get(item.item);
    if (normalized(entry.target_name) !== normalized(item.expected)) {
      throw new Error(`conflicting_target:${item.item}`);
    }
    if (!entry.aliases.some((alias) => alias.language === language.language
      && normalized(alias.value) === normalized(item.sourceName))) {
      entry.aliases.push({ language: language.language, value: item.sourceName });
    }
  }
}

const entries = [...grouped.values()].filter((entry) => entry.aliases.length);
let entriesWithCoordinates = 0;
for (let offset = 0; offset < entries.length; offset += 80) {
  const batch = entries.slice(offset, offset + 80);
  const coordinates = await coordinatesForEntities(batch.map((entry) => entry.id.replace("wikidata:", "")));
  for (const entry of batch) {
    const point = coordinates.get(entry.id.replace("wikidata:", ""));
    if (point) {
      entry.coordinates = point;
      entriesWithCoordinates += 1;
    }
  }
}
const output = { format_version: 2, generated_at: acceptance.generatedAt,
  uniqueness_audited_at: new Date().toISOString(), target_language: "fa",
  languages: acceptance.languages.map((item) => item.language), sources: {
    wikidata_endpoint: acceptance.endpoint, entity_class: acceptance.entityClass,
    source_rows: acceptance.languages.reduce((sum, language) => sum + language.items.length, 0),
    uniqueness_rule: "exactly_one_Q515_per_language_label",
    excluded_ambiguous_aliases: excludedAmbiguous, excluded_missing_aliases: excludedMissing,
    entries_with_coordinates: entriesWithCoordinates,
  }, entries };
const outputPath = new URL("../server/data/wikidata-place-gazetteer.mjs", import.meta.url);
await writeFile(outputPath, `// Generated by scripts/build_wikidata_place_gazetteer.mjs\nexport default ${JSON.stringify(output)};\n`, "utf8");
console.log(JSON.stringify({ entries: output.entries.length,
  aliases: output.entries.reduce((sum, entry) => sum + entry.aliases.length, 0),
  excludedAmbiguous, excludedMissing, entriesWithCoordinates }, null, 2));
