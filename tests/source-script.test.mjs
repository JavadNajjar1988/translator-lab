import assert from "node:assert/strict";
import test from "node:test";
import { detectSourceScript, sourceScriptStatus } from "../server/source-script.mjs";

test("source script detection covers the writing systems used by canonical map languages", () => {
  const samples = new Map([
    ["Deutschland", "latin"], ["ألمانيا", "arabic"], ["ישראל", "hebrew"],
    ["Москва", "cyrillic"], ["Αθήνα", "greek"], ["北京", "han"],
    ["ソウル", "katakana"], ["서울", "hangul"], ["दिल्ली", "devanagari"],
    ["ঢাকা", "bengali"], ["ਪੰਜਾਬ", "gurmukhi"], ["சென்னை", "tamil"],
    ["హైదరాబాద్", "telugu"], ["กรุงเทพ", "thai"], ["თბილისი", "georgian"],
    ["Երևան", "armenian"],
  ]);
  for (const [source, expected] of samples) {
    const result = detectSourceScript(source);
    assert.equal(result.dominantScript, expected, source);
    assert.equal(result.supported, true, source);
  }
});

test("source script detection marks mixed and language-ambiguous scripts", () => {
  const mixed = detectSourceScript("Tokyo 東京");
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.requiresLanguageMetadata, true);
  assert.deepEqual(detectSourceScript("تهران").candidateLanguages, ["ar", "fa", "ur"]);
  assert.equal(detectSourceScript("123-45").dominantScript, null);
});

test("script status covers all 40 canonical language labels", () => {
  assert.equal(sourceScriptStatus().languages.length, 40);
});
