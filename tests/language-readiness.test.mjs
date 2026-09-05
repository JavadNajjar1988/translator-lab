import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLanguageReadiness, languageReadinessStatus } from "../server/language-readiness.mjs";

test("language readiness exposes the complete multilingual model evaluation", () => {
  const result = languageReadinessStatus();
  assert.equal(result.modelEvaluation.summary.samples, 1586);
  assert.equal(result.modelEvaluation.summary.acceptableRate, 76.29);
  assert.equal(result.languages.find((item) => item.language === "zh").model.acceptableRate, 49.25);
  assert.equal(result.automaticApproval, false);
});

test("language readiness keeps baseline success separate from client approval", () => {
  const source = { version: 1, targetLanguage: "fa", minimumClientSamples: 200, languages: [
    { language: "de", label: "آلمانی", items: [["Deutschland", "آلمان", "place", "country"]] },
  ] };
  const resolver = { resolve(items) { return new Map([[items[0].key, { translatedName: "آلمان" }]]); } };
  const result = evaluateLanguageReadiness(source, resolver);
  assert.equal(result.passRate, 100);
  assert.equal(result.automaticApproval, false);
  assert.equal(result.languages[0].status, "baseline_passed_model_evaluation_required");
  assert.equal(result.languages[0].minimumClientSamples, 200);
});

test("language readiness exposes failures instead of granting approval", () => {
  const source = { version: 1, targetLanguage: "fa", minimumClientSamples: 200, languages: [
    { language: "xx", label: "آزمایشی", items: [["Source", "مقصد", "place", "city"]] },
  ] };
  const result = evaluateLanguageReadiness(source, { resolve() { return new Map(); } });
  assert.equal(result.languages[0].failed, 1);
  assert.equal(result.languages[0].status, "quality_gap");
});

test("language readiness measures independent reference coverage and precision", () => {
  const source = { version: 1, targetLanguage: "fa", minimumClientSamples: 200, languages: [
    { language: "de", label: "آلمانی", items: [["Deutschland", "آلمان", "place", "country"]] },
  ] };
  const reference = { generatedAt: "test", languages: [{ language: "de", items: [
    { sourceName: "Berlin", expected: "برلین", layer: "place", className: "city" },
    { sourceName: "Unknown", expected: "ناشناخته", layer: "place", className: "city" },
  ] }] };
  const resolver = { resolve(items) { return new Map(items.filter((item) => item.sourceName !== "Unknown")
    .map((item) => [item.key, { translatedName: item.sourceName === "Deutschland" ? "آلمان" : "برلین" }])); } };
  const result = evaluateLanguageReadiness(source, resolver, reference);
  assert.deepEqual(result.languages[0].reference, { samples: 2, resolved: 1, correct: 1, wrong: 0,
    unresolved: 1, coverageRate: 50, precision: 100 });
});
