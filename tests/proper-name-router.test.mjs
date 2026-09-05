import assert from "node:assert/strict";
import test from "node:test";
import { classifyMapName, resolveControlledNames } from "../server/proper-name-router.mjs";

test("router separates generic, identifier, mixed, and proper names", () => {
  assert.equal(classifyMapName({ sourceName: "Impasse" }).kind, "generic");
  assert.equal(classifyMapName({ sourceName: "A2-A3" }).kind, "identifier");
  assert.deepEqual(classifyMapName({ sourceName: "Avenue de Roqueville" }), {
    kind: "mixed", properCore: "roqueville", genericMarker: "avenue", requiresJudge: true,
  });
  assert.deepEqual(classifyMapName({ sourceName: "Dior" }), {
    kind: "proper", properCore: "Dior", requiresJudge: true,
  });
});

test("controlled resolver translates only exact generic names and preserves identifiers", () => {
  const hits = resolveControlledNames([
    { key: "one", sourceName: "Bahnhof" }, { key: "two", sourceName: "B-17" },
    { key: "three", sourceName: "Bahnhof Berlin" },
  ]);
  assert.equal(hits.get("one").translatedName, "ایستگاه");
  assert.equal(hits.get("two").translatedName, "B-17");
  assert.equal(hits.has("three"), false);
});
