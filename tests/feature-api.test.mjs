import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { rowToFeature } from "../server/features-repository.mjs";
import { createHttpServer } from "../server/http-app.mjs";
import { auditGeographicIdentities } from "../server/geographic-identity-audit.mjs";
import { createOsmIdentityResolver, loadOsmIdentitySnapshot,
  previewOsmIdentityEnrichment } from "../server/osm-identity-enrichment.mjs";

test("rowToFeature preserves live names and marks requested edits as stale", () => {
  const feature = rowToFeature({
    osm_type: "W", osm_id: "42", layer: "transportation_name",
    properties: { name: " Avenue Test ", class: "primary" },
    translate: { name: "خیابان آزمایشی", edit: "required", provider: "approved-memory" },
    geometry: { type: "Point", coordinates: [7.4, 43.7] },
  });

  assert.equal(feature.id, "W-42-transportation_name");
  assert.equal(feature.properties.source_name, "Avenue Test");
  assert.equal(feature.properties.status, "stale");
  assert.equal(feature.properties.edit_requested, true);
  assert.equal(feature.properties.provider, "approved-memory");
});

test("feature API returns the repository dataset without caching", async (context) => {
  const dataset = { type: "FeatureCollection", meta: { source: "postgresql:public.geoms", live: true }, features: [] };
  const repository = { health: async () => ({ database: "translator_lab", table: "geoms" }), readDataset: async () => dataset };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/features`, {
    headers: { origin: "http://127.0.0.1:3005" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:3005");
  assert.deepEqual(await response.json(), dataset);
});

test("feature API reports database failures without leaking details", async (context) => {
  context.mock.method(console, "error", () => {});
  const repository = { health: async () => ({}), readDataset: async () => { throw new Error("secret connection detail"); } };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/features`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "database_unavailable" });
});

test("language readiness API exposes evaluation status without writing data", async (context) => {
  const readiness = { automaticApproval: false, samples: 64, passed: 60, languages: [] };
  const repository = { updateTranslation: async () => assert.fail("readiness endpoint must not write") };
  const server = createHttpServer(repository, { languageReadinessStatus: () => readiness });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/language-readiness`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), readiness);
});

test("geographic identity audit API exposes a read-only live comparison", async (context) => {
  const audit = { readOnly: true, automaticApproval: false,
    summary: { scanned: 3, resolved: 2, mismatched: 1 } };
  const repository = { updateTranslation: async () => assert.fail("identity audit endpoint must not write") };
  const server = createHttpServer(repository, { geographicIdentityAudit: async () => audit });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/geographic-identity-audit`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), audit);
});

test("geographic identity audit compares live translations without writing", async () => {
  const candidates = [
    { id: "N-1-place", osmType: "N", osmId: "1", layer: "place", className: "city",
      sourceName: "One", translatedName: "یک", editRequested: false, longitude: 1, latitude: 1 },
    { id: "N-2-place", osmType: "N", osmId: "2", layer: "place", className: "city",
      sourceName: "Two", translatedName: "ترجمهٔ دیگر", longitude: 2, latitude: 2 },
    { id: "N-3-poi", osmType: "N", osmId: "3", layer: "poi", className: "shop",
      sourceName: "Shop", translatedName: "فروشگاه", longitude: 3, latitude: 3 },
    { id: "N-4-place", osmType: "N", osmId: "4", layer: "place", className: "suburb",
      sourceName: "Monaco-Ville", translatedName: "موناکو ویل", longitude: 4, latitude: 4 },
  ];
  const repository = { readGeographicIdentityCandidates: async () => candidates,
    updateTranslation: async () => assert.fail("read-only audit must not write") };
  const resolver = { resolve: () => new Map([
    ["N-1-place", { translatedName: "یک", canonicalId: "wikidata:Q1", provider: "canonical-place-coordinate",
      resolution: "coordinate" }],
    ["N-2-place", { translatedName: "دو", canonicalId: "wikidata:Q2", provider: "canonical-place-memory",
      resolution: "alias" }],
    ["N-4-place", { translatedName: "موناکوویل", canonicalId: "wikidata:Q4",
      provider: "canonical-place-memory", resolution: "alias" }],
  ]) };
  const result = await auditGeographicIdentities(repository, resolver);
  assert.equal(result.readOnly, true);
  assert.equal(result.automaticApproval, false);
  assert.deepEqual(result.summary, { scanned: 4, resolved: 3, unresolved: 1, consistent: 1,
    orthographicVariants: 1, mismatched: 1, missingTranslation: 0,
    methods: { identifier: 0, coordinate: 1, alias: 2 } });
  assert.equal(result.mismatches[0].canonicalTranslation, "دو");
  assert.equal(result.orthographicVariants[0].canonicalTranslation, "موناکوویل");
});

test("OSM identity enrichment previews snapshot identifiers without writing", async () => {
  const candidates = [
    { id: "N-1-place", osmType: "N", osmId: "1", layer: "place", className: "city",
      sourceName: "One", translatedName: "یک", longitude: 1, latitude: 1 },
    { id: "N-2-place", osmType: "N", osmId: "2", layer: "place", className: "city",
      sourceName: "Changed", translatedName: "دو", longitude: 2, latitude: 2 },
    { id: "N-3-poi", osmType: "N", osmId: "3", layer: "poi", className: "shop",
      sourceName: "Shop", translatedName: "فروشگاه", longitude: 3, latitude: 3 },
  ];
  const repository = { readGeographicIdentityCandidates: async () => candidates,
    updateTranslation: async () => assert.fail("enrichment preview must not write") };
  const snapshot = { source: "test", fetchedAt: "2026-09-05T00:00:00Z", scope: "test", entries: [
    { osmType: "N", osmId: "1", name: "One", wikidataId: "Q1", version: 1, timestamp: "test" },
    { osmType: "N", osmId: "2", name: "Two", wikidataId: "Q2", version: 1, timestamp: "test" },
  ] };
  const resolver = { resolve: () => new Map([["N-1-place", { translatedName: "یک",
    canonicalId: "wikidata:Q1", provider: "canonical-place-identifier" }]]) };
  const result = await previewOsmIdentityEnrichment(repository, resolver, snapshot);
  assert.equal(result.readOnly, true);
  assert.equal(result.applyAvailable, false);
  assert.deepEqual(result.summary, { scanned: 3, snapshotMatches: 2, absentFromSnapshot: 1,
    identifiersFound: 2, withoutIdentifier: 0, sourceNameChanged: 1,
    resolvedNames: 1, approvedMemoryResolved: 0, canonicalResolved: 1, missingCanonicalName: 0 });
  assert.deepEqual(result.quality, { canonicalConsistent: 1, orthographicVariants: 0,
    translationReview: 0, missingTranslation: 0 });
  assert.deepEqual(result.decisions, { noAction: 1, safeAutomatic: 0,
    waitingForTrigger: 0, modelRequired: 0 });
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].proposedWikidataId, "Q1");
});

test("OSM identity preview counts client-approved identity names before model work", async () => {
  const candidate = { id: "W-9-water_name_detail", osmType: "W", osmId: "9",
    layer: "water_name_detail", className: "lake", sourceName: "Known fountain",
    translatedName: "فوارهٔ شناخته‌شده", longitude: 1, latitude: 1 };
  const repository = { readGeographicIdentityCandidates: async () => [candidate],
    updateTranslation: async () => assert.fail("identity preview must stay read-only") };
  const snapshot = { source: "test", fetchedAt: "2026-09-05T00:00:00Z", scope: "test", entries: [
    { osmType: "W", osmId: "9", name: "Known fountain", wikidataId: "Q9" },
  ] };
  const approvedMemory = { resolve: async () => new Map([[candidate.id, {
    translatedName: "فوارهٔ شناخته‌شده", provider: "approved-identity-memory",
    canonicalId: "wikidata:Q9" }]]) };
  const result = await previewOsmIdentityEnrichment(repository, { resolve: () => new Map() },
    snapshot, 10_000, approvedMemory);
  assert.equal(result.summary.resolvedNames, 1);
  assert.equal(result.summary.approvedMemoryResolved, 1);
  assert.equal(result.summary.missingCanonicalName, 0);
  assert.equal(result.decisions.noAction, 1);
  assert.equal(result.decisions.modelRequired, 0);
});

test("offline OSM identity resolver enriches only an exact source element", () => {
  const snapshot = { fetchedAt: "2026-09-05T00:00:00Z", entries: [
    { osmType: "N", osmId: "1", name: "Known place", wikidataId: "Q123" },
  ] };
  const resolve = createOsmIdentityResolver(snapshot);
  assert.deepEqual(resolve({ osmType: "N", osmId: "1", sourceName: "Known place", wikidataId: "" }),
    { osmType: "N", osmId: "1", sourceName: "Known place", wikidataId: "Q123",
      identitySource: "offline-osm-snapshot", identitySnapshotAt: "2026-09-05T00:00:00Z" });
  assert.equal(resolve({ osmType: "N", osmId: "1", sourceName: "Changed place", wikidataId: "" }).wikidataId, "");
});

test("offline OSM identity snapshot can be loaded from a generated JSON file", async (context) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "translator-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "snapshot.json");
  await writeFile(path, JSON.stringify({ source: "test", fetchedAt: "2026-09-05T00:00:00Z",
    scope: "test", entries: [{ osmType: "N", osmId: "1", name: "Known", wikidataId: "Q1" }] }));
  const snapshot = await loadOsmIdentitySnapshot(path);
  assert.equal(snapshot.entries[0].wikidataId, "Q1");
  assert.equal(createOsmIdentityResolver(snapshot)({ osmType: "N", osmId: "1", sourceName: "Known" }).wikidataId, "Q1");
});

test("OSM identity enrichment API is read-only", async (context) => {
  const preview = { readOnly: true, applyAvailable: false, summary: { identifiersFound: 9 } };
  const repository = { updateTranslation: async () => assert.fail("enrichment endpoint must not write") };
  const server = createHttpServer(repository, { osmIdentityEnrichment: async () => preview });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/osm-identity-enrichment`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), preview);
});

test("database connection API tests and activates through the manager", async (context) => {
  const connection = { host: "db.local", port: 5432, database: "maps", user: "translator",
    schema: "public", table: "geoms", sslMode: "disable", passwordConfigured: true, saved: false };
  const inspection = { ok: true, readyForRead: true, readyForAutomation: true, checks: [] };
  let tested;
  let activated;
  const connectionManager = {
    status: () => ({ connected: true, connection, inspection }),
    test: async (input) => { tested = input; return inspection; },
    activate: async (input, remember) => { activated = { input, remember };
      return { activated: true, connection: { ...connection, saved: remember }, inspection }; },
  };
  const server = createHttpServer({}, { connectionManager, worker: { status: () => ({ running: false }) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  const statusResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/database-connection`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), { connected: true, connection, inspection });

  const input = { host: "db.local", port: 5432, database: "maps", user: "translator",
    password: "secret", schema: "public", table: "geoms", sslMode: "disable", remember: true };
  const testResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/database-connections/test`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(testResponse.status, 200);
  assert.deepEqual(tested, input);

  const activateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/database-connections/activate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(activateResponse.status, 200);
  assert.deepEqual(activated, { input, remember: true });
  const activatedBody = await activateResponse.json();
  assert.equal(activatedBody.connection.password, undefined);
  assert.equal(activatedBody.connection.saved, true);
});

test("translation API persists one reviewed feature with its concurrency guard", async (context) => {
  let received;
  const updatedFeature = rowToFeature({
    osm_type: "W", osm_id: "42", layer: "transportation_name",
    properties: { name: "Avenue Test", class: "primary" },
    translate: { name: "خیابان آزمون", provider: "manual", translated_at: "2026-08-31T00:00:00.000Z" },
    geometry: { type: "Point", coordinates: [7.4, 43.7] },
  });
  const repository = {
    updateTranslation: async (input) => { received = input; return { status: "updated", feature: updatedFeature }; },
  };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translations`, {
    method: "PATCH", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3005" },
    body: JSON.stringify({ osmType: "W", osmId: "42", layer: "transportation_name",
      translatedName: "خیابان آزمون", provider: "manual", expectedSourceName: "Avenue Test",
      expectedTranslatedName: "خیابان آزمایشی" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:3005");
  assert.deepEqual(received, { osmType: "W", osmId: "42", layer: "transportation_name",
    translatedName: "خیابان آزمون", provider: "manual", expectedSourceName: "Avenue Test",
    expectedTranslatedName: "خیابان آزمایشی", reason: "reviewed" });
  assert.deepEqual(await response.json(), { feature: updatedFeature });
});

test("translation API rejects invalid bodies before reaching the repository", async (context) => {
  const repository = { updateTranslation: async () => assert.fail("invalid input reached repository") };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translations`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ translatedName: "" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_translation" });
});

test("translation API reports optimistic concurrency conflicts", async (context) => {
  const repository = { updateTranslation: async () => ({ status: "conflict",
    current: { sourceName: "Avenue Test", translatedName: "ترجمه تازه‌تر" } }) };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translations`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ osmType: "W", osmId: "42", layer: "transportation_name",
      translatedName: "خیابان آزمون", provider: "manual", expectedSourceName: "Avenue Test",
      expectedTranslatedName: "ترجمه قدیمی" }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "translation_conflict",
    current: { sourceName: "Avenue Test", translatedName: "ترجمه تازه‌تر" } });
});

test("translation queue and preview run are exposed without enabling automatic writes", async (context) => {
  const queue = { candidates: [{ id: "W-42-poi", sourceName: "Jardin Test" }],
    summary: { records: 1, uniqueNames: 1, newNames: 1, requestedEdits: 0 } };
  const preview = { status: "preview", translations: [{ sourceName: "Jardin Test",
    translatedName: "باغ آزمایشی", provider: "test:model" }] };
  const worker = { scan: async () => queue, status: () => ({ automaticApply: false }),
    runOnce: async (input) => { assert.deepEqual(input, { apply: false, limit: 5 }); return preview; } };
  const server = createHttpServer({}, { worker, allowApiApply: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  const queueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-queue?limit=20`);
  assert.equal(queueResponse.status, 200);
  assert.deepEqual(await queueResponse.json(), queue);
  const runResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-jobs/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: false, limit: 5 }),
  });
  assert.equal(runResponse.status, 200);
  assert.deepEqual(await runResponse.json(), preview);
});

test("translation job API rejects automatic apply while acceptance lock is active", async (context) => {
  const worker = { runOnce: async () => assert.fail("locked apply reached worker") };
  const server = createHttpServer({}, { worker, allowApiApply: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-jobs/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true, limit: 1 }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "automatic_apply_disabled" });
});

test("provider status and comparison APIs remain read-only", async (context) => {
  const providers = [{ kind: "gemini", model: "gemini-test", configured: true, ready: true },
    { kind: "local", model: "", configured: false, ready: false }];
  let received;
  const comparison = { results: [{ ...providers[0], ok: true, durationMs: 12,
    translations: [{ key: "comparison", translatedName: "خیابان آزمایش", strategy: "translation" }] }] };
  const server = createHttpServer({ updateTranslation: async () => assert.fail("comparison must not write") }, {
    allowOnlineComparison: true,
    providerStatuses: async () => providers,
    compareTranslations: async (items) => { received = items; return comparison; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  const statusResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-providers`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), { providers });

  const comparisonResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-comparisons`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceName: " Avenue Test ", layer: "transportation_name", className: "primary" }),
  });
  assert.equal(comparisonResponse.status, 200);
  assert.deepEqual(received, [{ key: "comparison", sourceName: "Avenue Test",
    layer: "transportation_name", className: "primary" }]);
  assert.deepEqual(await comparisonResponse.json(), comparison);

  const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-comparisons`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceName: " " }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: "invalid_comparison_input" });
});

test("offline preview API validates a batch and never writes to the repository", async (context) => {
  let received;
  const result = { provider: "local:test-model", translations: [{ key: "single",
    translatedName: "خیابان آزمایش", strategy: "translation" }] };
  const server = createHttpServer({ updateTranslation: async () => assert.fail("preview must not write") }, {
    translatePreview: async (items) => { received = items; return result; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-previews`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ key: "single", sourceName: " Avenue Test ",
      layer: "transportation_name", className: "primary", wikidataId: "Q172",
      longitude: 7.4, latitude: 43.7 }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, [{ key: "single", sourceName: "Avenue Test",
    layer: "transportation_name", className: "primary", wikidataId: "Q172",
    longitude: 7.4, latitude: 43.7 }]);
  assert.deepEqual(await response.json(), result);
  const invalid = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-previews`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ key: "same", sourceName: "A" }, { key: "same", sourceName: "B" }] }),
  });
  assert.equal(invalid.status, 400);
});

test("online comparison is disabled unless an evaluation environment explicitly enables it", async (context) => {
  const server = createHttpServer({}, { compareTranslations: async () => assert.fail("online comparison must stay locked") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-comparisons`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceName: "Avenue Test" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "online_provider_disabled" });
});

test("translation history API lists one feature and rolls back a safe entry", async (context) => {
  let historyFilter;
  let rollbackId;
  const feature = rowToFeature({ osm_type: "W", osm_id: "42", layer: "poi",
    properties: { name: "Jardin Test" }, translate: {}, geometry: { type: "Point", coordinates: [7.4, 43.7] } });
  const entries = [{ id: "9", osmType: "W", osmId: "42", layer: "poi",
    previousTranslation: "", newTranslation: "باغ آزمایشی" }];
  const repository = {
    readTranslationHistory: async (filter) => { historyFilter = filter; return entries; },
    rollbackTranslation: async (id) => { rollbackId = id; return { status: "rolled_back", feature, audit: { id: "10" } }; },
  };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-history?osmType=W&osmId=42&layer=poi&limit=5`);
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(await historyResponse.json(), { entries });
  assert.deepEqual(historyFilter, { osmType: "W", osmId: "42", layer: "poi", limit: 5 });

  const rollbackResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-history/9/rollback`, { method: "POST" });
  assert.equal(rollbackResponse.status, 200);
  assert.equal(rollbackId, "9");
  assert.deepEqual(await rollbackResponse.json(), { feature, audit: { id: "10" } });
});

test("translation rollback API refuses entries superseded by a later change", async (context) => {
  const repository = { rollbackTranslation: async () => ({ status: "conflict",
    current: { sourceName: "Jardin Test", translatedName: "ترجمه جدیدتر" } }) };
  const server = createHttpServer(repository);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/translation-history/9/rollback`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conflict",
    current: { sourceName: "Jardin Test", translatedName: "ترجمه جدیدتر" } });
});
