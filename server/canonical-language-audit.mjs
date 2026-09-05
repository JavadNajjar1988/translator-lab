import { createCanonicalPlaceNames } from "./canonical-place-names.mjs";
import { detectSourceScript } from "./source-script.mjs";

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function contextFor(entry) {
  const kind = entry.kind || entry.kinds?.[0] || "";
  if (["country", "city", "capital", "admin1"].includes(kind)) {
    return { layer: "place", className: kind };
  }
  if (["river", "river_intermittent", "canal", "lake", "alkaline_lake", "lake_centerline",
    "reservoir", "sea", "ocean", "gulf", "bay", "strait", "channel", "sound", "lagoon",
    "fjord", "reef"].includes(kind)) {
    const className = kind === "river_intermittent" ? "river"
      : kind === "alkaline_lake" || kind === "lake_centerline" ? "lake" : kind;
    return { layer: "water_name", className };
  }
  if (["mountain", "range_mtn", "island", "island_group"].includes(kind)) {
    const className = kind === "range_mtn" ? "mountain_range"
      : kind === "island_group" ? "island" : kind;
    return { layer: "natural", className };
  }
  return { layer: "natural", className: kind };
}

function sameSafeTarget(hit, entry) {
  if (!hit) return false;
  if (hit.canonicalId === entry.id) return true;
  const actual = normalized(hit.translatedName);
  const expected = normalized(entry.target_name);
  return actual === expected || actual.endsWith(` ${expected}`);
}

export function auditCanonicalLanguages(source, { sampleLimit = 8 } = {}) {
  const resolver = createCanonicalPlaceNames(source);
  const languages = source.languages || [];
  const rowsByLanguage = new Map(languages.map((language) => [language, []]));
  for (const entry of source.entries || []) {
    const seen = new Set();
    for (const alias of entry.aliases || []) {
      if (!rowsByLanguage.has(alias.language)) continue;
      const value = normalized(alias.value);
      const dedupeKey = `${alias.language}\u0000${entry.id}\u0000${value}`;
      if (!value || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rowsByLanguage.get(alias.language).push({ entry, value: alias.value });
    }
  }

  const languageResults = [];
  for (const language of languages) {
    const rows = rowsByLanguage.get(language);
    const sourceValues = new Map();
    const items = rows.map(({ entry, value }, index) => {
      const sourceKey = normalized(value);
      if (!sourceValues.has(sourceKey)) sourceValues.set(sourceKey, new Set());
      sourceValues.get(sourceKey).add(entry.id);
      return { key: `${language}:${index}`, sourceName: value, ...contextFor(entry) };
    });
    const hits = resolver.resolve(items);
    let safe = 0;
    let wrong = 0;
    const unresolvedSamples = [];
    const wrongSamples = [];
    const scripts = {};
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const hit = hits.get(`${language}:${index}`);
      const script = detectSourceScript(row.value).dominantScript || "none";
      scripts[script] = (scripts[script] || 0) + 1;
      if (sameSafeTarget(hit, row.entry)) {
        safe += 1;
      } else if (hit) {
        wrong += 1;
        if (wrongSamples.length < sampleLimit) {
          wrongSamples.push({ source: row.value, expected: row.entry.target_name, actual: hit.translatedName });
        }
      } else if (unresolvedSamples.length < sampleLimit) {
        unresolvedSamples.push({ source: row.value, expected: row.entry.target_name, kind: row.entry.kind });
      }
    }
    const ambiguousValues = [...sourceValues.values()].filter((ids) => ids.size > 1).length;
    languageResults.push({
      language,
      aliases: rows.length,
      distinctSourceValues: sourceValues.size,
      ambiguousValues,
      safe,
      wrong,
      unresolved: rows.length - safe - wrong,
      safeRate: rows.length ? Number((safe * 100 / rows.length).toFixed(2)) : 0,
      scripts,
      unresolvedSamples,
      wrongSamples,
    });
  }

  const totals = languageResults.reduce((result, row) => ({
    aliases: result.aliases + row.aliases,
    safe: result.safe + row.safe,
    wrong: result.wrong + row.wrong,
    unresolved: result.unresolved + row.unresolved,
  }), { aliases: 0, safe: 0, wrong: 0, unresolved: 0 });
  totals.safeRate = totals.aliases ? Number((totals.safe * 100 / totals.aliases).toFixed(2)) : 0;

  return {
    generatedAt: new Date().toISOString(),
    datasetGeneratedAt: source.generated_at,
    targetLanguage: source.target_language,
    languageCount: languages.length,
    entryCount: source.entries?.length || 0,
    totals,
    languages: languageResults,
  };
}
