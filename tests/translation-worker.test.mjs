import assert from "node:assert/strict";
import test from "node:test";
import { createTranslationWorker, isSafeAutomaticTranslation,
  translationKey } from "../server/translation-worker.mjs";

const candidates = [
  { id: "W-1-poi", osmType: "W", osmId: "1", layer: "poi", sourceName: "Jardin Test",
    translatedName: "", className: "park", editRequested: false },
  { id: "W-2-poi", osmType: "W", osmId: "2", layer: "poi", sourceName: "Jardin Test",
    translatedName: "", className: "park", editRequested: false },
  { id: "N-3-place", osmType: "N", osmId: "3", layer: "place", sourceName: "Monaco",
    translatedName: "موناکو", className: "city", editRequested: true },
];

test("translation worker deduplicates model calls and keeps preview read-only", async () => {
  const repository = {
    readTranslationQueue: async () => candidates,
    updateTranslation: async () => assert.fail("preview must not update the database"),
  };
  let received;
  const worker = createTranslationWorker(repository, async (items) => {
    received = items;
    return { provider: "test:model", translations: items.map((item) => ({ key: item.key,
      translatedName: item.sourceName === "Monaco" ? "موناکو" : "باغ آزمایشی", strategy: "mixed" })) };
  }, { batchSize: 20 });

  const result = await worker.runOnce({ apply: false, limit: 5 });
  assert.equal(result.status, "preview");
  assert.equal(received.length, 2);
  assert.equal(result.translations.length, 2);
  assert.deepEqual(result.summary, { records: 3, uniqueNames: 2, newNames: 2, requestedEdits: 1 });
});

test("translation worker enriches queued OSM identities before translation", async () => {
  const source = [{ id: "N-1-place", osmType: "N", osmId: "1", layer: "place",
    sourceName: "Known place", translatedName: "", className: "city", editRequested: false }];
  let received;
  const worker = createTranslationWorker({ readTranslationQueue: async () => source }, async (items) => {
    received = items;
    return { provider: "canonical-place-identifier", translations: items.map((item) => ({
      key: item.key, translatedName: "مکان معیار", strategy: "translation",
      provider: "canonical-place-identifier" })) };
  }, { enrichIdentity: (candidate) => ({ ...candidate, wikidataId: "Q123" }) });
  const result = await worker.runOnce({ apply: false, limit: 1 });
  assert.equal(received[0].wikidataId, "Q123");
  assert.equal(result.translations[0].provider, "canonical-place-identifier");
});

test("translation worker applies one model result to matching pending records with guards", async () => {
  const updates = [];
  const repository = {
    readTranslationQueue: async () => candidates,
    updateTranslation: async (input) => { updates.push(input); return { status: "updated" }; },
  };
  const worker = createTranslationWorker(repository, async (items) => ({ provider: "test:model",
    translations: items.map((item) => ({ key: item.key,
      translatedName: item.sourceName === "Monaco" ? "موناکو" : "باغ آزمایشی", strategy: "mixed" })) }),
  { batchSize: 20 });

  const result = await worker.runOnce({ apply: true, limit: 5 });
  assert.equal(result.status, "applied");
  assert.equal(result.persistence.updated, 3);
  assert.equal(updates.length, 3);
  assert.equal(updates[0].expectedSourceName, "Jardin Test");
  assert.equal(updates[0].expectedTranslatedName, "");
  assert.equal(updates[0].reason, "new_name");
  assert.equal(updates[2].expectedTranslatedName, "موناکو");
  assert.equal(updates[2].reason, "edit_requested");
  assert.equal(updates[2].provider, "test:model");
  assert.equal(worker.status().lastAppliedRun.persistence.updated, 3);
});

test("translation key includes source, layer, and class context", () => {
  assert.notEqual(translationKey(candidates[0]), translationKey({ ...candidates[0], layer: "place" }));
});

test("translation key keeps same-named geographic features separate by identity or location", () => {
  const place = { sourceName: "Springfield", layer: "place", className: "city", longitude: 10, latitude: 10 };
  assert.notEqual(translationKey(place), translationKey({ ...place, longitude: 40, latitude: 40 }));
  assert.notEqual(translationKey(place), translationKey({ ...place, wikidataId: "Q123" }));
});

test("translation worker status exposes safe provider details without credentials", () => {
  const provider = { kind: "gemini", model: "gemini-test", configured: true };
  const worker = createTranslationWorker({ readTranslationQueue: async () => [] }, async () => ({}), { provider });
  assert.deepEqual(worker.status().provider, provider);
  assert.equal("apiKey" in worker.status().provider, false);
});

test("automatic apply does not persist names that still require a judge", async () => {
  const updates = [];
  const repository = {
    readTranslationQueue: async () => candidates.slice(0, 2),
    updateTranslation: async (input) => { updates.push(input); return { status: "updated" }; },
  };
  const worker = createTranslationWorker(repository, async (items) => ({ provider: "madlad:test",
    translations: items.map((item) => ({ key: item.key, translatedName: "ژاردن تست", strategy: "mixed",
      nameKind: "mixed", reviewRequired: true })) }), { batchSize: 20 });
  const result = await worker.runOnce({ apply: true, limit: 5 });
  assert.equal(result.persistence.updated, 0);
  assert.equal(result.persistence.reviewRequired, 2);
  assert.equal(updates.length, 0);
});

test("automatic runs persist only trusted deterministic providers and never call the model", async () => {
  const updates = [];
  const source = [
    { ...candidates[0], id: "W-10-poi", osmId: "10", sourceName: "Park" },
    { ...candidates[0], id: "W-11-poi", osmId: "11", sourceName: "Unknown Name" },
  ];
  const repository = { readTranslationQueue: async () => source,
    updateTranslation: async (input) => { updates.push(input); return { status: "updated" }; } };
  const worker = createTranslationWorker(repository,
    async () => assert.fail("automatic deterministic run must not call the model"), {
      automaticApply: true,
      automaticTranslate: async (items) => ({ provider: "controlled-generic-memory", deterministicOnly: true,
        translations: [{ key: items[0].key, translatedName: "پارک", strategy: "translation",
          provider: "controlled-generic-memory", reviewRequired: false }] }),
    });
  const result = await worker.runOnce({ apply: true, automatic: true, limit: 2 });
  assert.equal(result.persistence.updated, 1);
  assert.equal(result.persistence.policySkipped, 1);
  assert.equal(updates[0].translatedName, "پارک");
  assert.equal(isSafeAutomaticTranslation({ provider: "local:test", reviewRequired: false }), false);
  assert.equal(isSafeAutomaticTranslation({ provider: "approved-memory", reviewRequired: false }), true);
});

test("automatic worker scans immediately and keeps one periodic timer", async () => {
  let scans = 0;
  const repository = { readTranslationQueue: async () => { scans += 1; return []; } };
  const worker = createTranslationWorker(repository, async () => assert.fail("empty queue must not call model"),
    { automaticApply: true, intervalMs: 60_000 });

  assert.equal(worker.start(), true);
  assert.equal(worker.start(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1);
  assert.equal(worker.status().lastRun.status, "empty");
  assert.equal(worker.status().lastRun.apply, true);
  worker.stop();
});
