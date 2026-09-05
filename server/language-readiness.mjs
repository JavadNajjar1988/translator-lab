import { canonicalPlaceNames } from "./canonical-place-names.mjs";
import seed from "./data/language-acceptance-seed.mjs";
import wikidataHoldout from "./data/wikidata-language-holdout.mjs";
import modelLanguageSmoke from "./data/model-language-smoke.mjs";

function normalize(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\u200c/g, "").replace(/\s+/g, " ").replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک").toLocaleLowerCase("fa");
}

function evaluateReference(language, resolver) {
  if (!language?.items?.length) return { samples: 0, resolved: 0, correct: 0, wrong: 0,
    unresolved: 0, coverageRate: 0, precision: 0 };
  const items = language.items.map((item, index) => ({ key: `reference:${language.language}:${index}`,
    sourceName: item.sourceName, layer: item.layer, className: item.className }));
  const hits = resolver.resolve(items);
  let correct = 0;
  let wrong = 0;
  items.forEach((item, index) => {
    const hit = hits.get(item.key);
    if (!hit) return;
    if (normalize(hit.translatedName) === normalize(language.items[index].expected)) correct += 1;
    else wrong += 1;
  });
  const samples = items.length;
  const resolved = hits.size;
  return { samples, resolved, correct, wrong, unresolved: samples - resolved,
    coverageRate: Number((resolved * 100 / samples).toFixed(2)),
    precision: resolved ? Number((correct * 100 / resolved).toFixed(2)) : 0 };
}

export function evaluateLanguageReadiness(source = seed, resolver = canonicalPlaceNames,
  referenceSource = source === seed ? wikidataHoldout : { languages: [] }) {
  const referenceByLanguage = new Map((referenceSource.languages || []).map((item) => [item.language, item]));
  const languages = source.languages.map((definition) => {
    const items = definition.items.map(([sourceName, , layer, className], index) => ({
      key: `${definition.language}:${index}`, sourceName, layer, className,
    }));
    const hits = resolver.resolve(items);
    const failures = [];
    let passed = 0;
    definition.items.forEach(([sourceName, expected], index) => {
      const actual = hits.get(`${definition.language}:${index}`)?.translatedName || "";
      if (normalize(actual) === normalize(expected)) passed += 1;
      else failures.push({ sourceName, expected, actual: actual || null });
    });
    const samples = definition.items.length;
    const passRate = samples ? Number((passed * 100 / samples).toFixed(2)) : 0;
    const reference = evaluateReference(referenceByLanguage.get(definition.language), resolver);
    const model = source === seed ? modelLanguageSmoke.languages[definition.language] || null : null;
    return { language: definition.language, label: definition.label, samples, passed,
      failed: samples - passed, passRate, clientSamples: 0, minimumClientSamples: source.minimumClientSamples,
      reference, model, status: failures.length || reference.wrong || model?.different || model?.uncertain
        || model?.invalid || model?.errors
        ? "quality_gap" : "baseline_passed_model_evaluation_required", failures };
  });
  const passed = languages.reduce((sum, language) => sum + language.passed, 0);
  const samples = languages.reduce((sum, language) => sum + language.samples, 0);
  return { version: source.version, targetLanguage: source.targetLanguage,
    automaticApproval: false, evaluatedAt: new Date().toISOString(),
    referenceGeneratedAt: referenceSource.generatedAt || null, samples, passed,
    passRate: samples ? Number((passed * 100 / samples).toFixed(2)) : 0,
    modelEvaluation: modelLanguageSmoke, languages };
}

const readiness = evaluateLanguageReadiness();
export function languageReadinessStatus() {
  return readiness;
}
