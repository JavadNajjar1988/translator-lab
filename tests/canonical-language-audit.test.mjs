import assert from "node:assert/strict";
import test from "node:test";
import { auditCanonicalLanguages } from "../server/canonical-language-audit.mjs";

test("canonical language audit reports safe, ambiguous, and unresolved aliases per language", () => {
  const source = { target_language: "fa", generated_at: "test", languages: ["en", "de"], entries: [
    { id: "country:DE", kind: "country", target_name: "آلمان", aliases: [
      { language: "en", value: "Germany" }, { language: "de", value: "Deutschland" },
    ] },
    { id: "country:A", kind: "country", target_name: "الف", aliases: [{ language: "en", value: "Same" }] },
    { id: "country:B", kind: "country", target_name: "ب", aliases: [{ language: "en", value: "Same" }] },
  ] };
  const result = auditCanonicalLanguages(source);
  const english = result.languages.find((row) => row.language === "en");
  const german = result.languages.find((row) => row.language === "de");
  assert.equal(english.aliases, 3);
  assert.equal(english.safe, 1);
  assert.equal(english.ambiguousValues, 1);
  assert.equal(english.unresolved, 2);
  assert.equal(german.safeRate, 100);
  assert.equal(result.totals.wrong, 0);
});
