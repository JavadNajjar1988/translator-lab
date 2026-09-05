import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedTranslationMemory, configureApprovedTranslationMemory,
  createTranslationMemory, translationMemoryKey } from "../server/translation-memory.mjs";
import { mergeIdentitySnapshotHistory } from "../server/osm-identity-snapshot-history.mjs";

async function memoryFixture(context, entries) {
  const directory = await mkdtemp(join(tmpdir(), "translator-memory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.json");
  await writeFile(path, JSON.stringify({ source_sha256: "approved", entries }), "utf8");
  return createTranslationMemory(path, { entries: [] });
}

test("approved memory resolves the exact source, layer, and class without a model", async (context) => {
  const memory = await memoryFixture(context, [{ source_name: "Monaco", layer: "place", class: "country",
    translated_name: "موناکو", approval_status: "client_approved" }]);
  const hits = await memory.resolve([
    { key: "hit", sourceName: " Monaco ", layer: "place", className: "country" },
    { key: "miss", sourceName: "Monaco", layer: "place", className: "city" },
  ]);
  assert.deepEqual(hits.get("hit"), { key: "hit", translatedName: "موناکو", strategy: "mixed",
    provider: "approved-memory" });
  assert.equal(hits.has("miss"), false);
  assert.deepEqual(memory.status(), { configured: true, loaded: true, entries: 1, lookupKeys: 1,
    identityBindings: 0, aliases: 0, conflicts: 0,
    sourceSha256: "approved" });
  assert.notEqual(translationMemoryKey({ sourceName: "Monaco", layer: "place", className: "country" }),
    translationMemoryKey({ sourceName: "Monaco", layer: "place", className: "city" }));
  assert.notEqual(translationMemoryKey({ sourceName: "MonaBike", layer: "poi", className: "amenity" }),
    translationMemoryKey({ sourceName: "Monabike", layer: "poi", className: "amenity" }));
});

test("approved memory binds an exact client translation to one offline geographic identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "translator-memory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.json");
  await writeFile(path, JSON.stringify({ entries: [{ source_name: "Jardin Exotique", layer: "place",
    class: "suburb", translated_name: "باغ اگزوتیک", approval_status: "client_approved" }] }), "utf8");
  const memory = createTranslationMemory(path, { entries: [
    { name: "Jardin Exotique", wikidataId: "Q19286504" },
  ] });
  const hits = await memory.resolve([
    { key: "same", sourceName: "renamed upstream", layer: "place", className: "suburb",
      wikidataId: "Q19286504" },
    { key: "wrong", sourceName: "Jardin Exotique", layer: "place", className: "suburb",
      wikidataId: "Q999" },
  ]);
  assert.deepEqual(hits.get("same"), { key: "same", translatedName: "باغ اگزوتیک", strategy: "mixed",
    provider: "approved-identity-memory", canonicalId: "wikidata:Q19286504", resolution: "approved-identity",
    reviewRequired: false, automaticApproval: "client-approved-identity" });
  assert.equal(hits.has("wrong"), false);
  assert.equal(memory.status().identityBindings, 1);
});

test("configured approved memory uses the generated identity snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "translator-memory-configured-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.json");
  await writeFile(path, JSON.stringify({ entries: [{ source_name: "New upstream place", layer: "place",
    class: "suburb", translated_name: "مکان تازه", approval_status: "client_approved" }] }), "utf8");
  configureApprovedTranslationMemory({ entries: [
    { name: "New upstream place", wikidataId: "Q99010838" },
  ] }, path);
  const hits = await approvedTranslationMemory.resolve([{ key: "renamed", sourceName: "Renamed place",
    layer: "place", className: "suburb", wikidataId: "Q99010838" }]);
  assert.equal(hits.get("renamed")?.translatedName, "مکان تازه");
  assert.equal(hits.get("renamed")?.provider, "approved-identity-memory");
});

test("a refreshed identity snapshot preserves an approved translation across a source rename", async (context) => {
  const oldSnapshot = { entries: [{ osmType: "W", osmId: "9", name: "Old fountain",
    wikidataId: "Q9" }] };
  const entries = mergeIdentitySnapshotHistory([{ osmType: "W", osmId: "9", name: "Renamed fountain",
    wikidataId: "Q9" }], oldSnapshot);
  assert.deepEqual(entries[0].previousNames, ["Old fountain"]);
  const directory = await mkdtemp(join(tmpdir(), "translator-memory-renamed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.json");
  await writeFile(path, JSON.stringify({ entries: [{ source_name: "Old fountain", layer: "water_name_detail",
    class: "lake", translated_name: "فوارهٔ قدیمی", approval_status: "client_approved" }] }), "utf8");
  const memory = createTranslationMemory(path, { entries });
  const hits = await memory.resolve([{ key: "renamed", sourceName: "Renamed fountain",
    layer: "water_name_detail", className: "lake", wikidataId: "Q9" }]);
  assert.equal(hits.get("renamed")?.translatedName, "فوارهٔ قدیمی");
  assert.equal(hits.get("renamed")?.provider, "approved-identity-memory");
});

test("identity history is discarded when the Wikidata identity changes", () => {
  const entries = mergeIdentitySnapshotHistory([{ osmType: "W", osmId: "9", name: "Different feature",
    wikidataId: "Q10" }], { entries: [{ osmType: "W", osmId: "9", name: "Old fountain",
    wikidataId: "Q9" }] });
  assert.equal(entries[0].previousNames, undefined);
});

test("approved memory fails closed when one context has conflicting translations", async (context) => {
  const base = { source_name: "Impasse", layer: "transportation_name", class: "service",
    approval_status: "client_approved" };
  const memory = await memoryFixture(context, [{ ...base, translated_name: "بن‌بست" },
    { ...base, translated_name: "کوچه" }]);
  await assert.rejects(memory.load(), /تعارض/);
});
