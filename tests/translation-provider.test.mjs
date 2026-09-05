import assert from "node:assert/strict";
import test from "node:test";
import { translateMapNamesWithProvider, translationProviderStatus,
  translationProviderStatuses, translationQualityIssues } from "../server/translation-provider.mjs";

function preserveEnvironment(context, names) {
  const original = new Map(names.map((name) => [name, process.env[name]]));
  context.after(() => original.forEach((value, name) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }));
}

test("provider status exposes configuration without credentials", () => {
  const status = translationProviderStatus("local");
  assert.equal(status.kind, "local");
  assert.equal("apiKey" in status, false);
});

test("deterministic quality rules cover approved map-label conventions", () => {
  assert.deepEqual(translationQualityIssues({ sourceName: "Willliam Grover;William Grover",
    layer: "poi", className: "art_gallery" }, "ویلیام گروور"), ["class:art_gallery=گالری"]);
  assert.deepEqual(translationQualityIssues({ sourceName: "Caffè Milano",
    layer: "poi", className: "amenity" }, "کافه میلان"), ["Caffè Milano=کافه میلانو"]);
  assert.deepEqual(translationQualityIssues({ sourceName: "Caffè Milano",
    layer: "poi", className: "amenity" }, "کافه میلانو"), []);
  assert.deepEqual(translationQualityIssues({ sourceName: "Toronto",
    layer: "place", className: "city" }, "تورنتوworld. kgm"),
  ["target:latin-contamination", "target:metadata-contamination"]);
  assert.deepEqual(translationQualityIssues({ sourceName: "Nuuk",
    layer: "place", className: "city" }, ". شلیک کن"), ["target:leading-punctuation"]);
  assert.deepEqual(translationQualityIssues({ sourceName: "Observatoire Cartographique Alpha",
    layer: "poi", className: "museum" }, "آلبا، موزه"), [
    "Observatoire/Observatory=رصدخانه",
    "Cartographique/Cartographic=نقشه‌نگاری",
    "Alpha=آلفا",
  ]);
  assert.deepEqual(translationQualityIssues({ sourceName: "Observatoire Cartographique Alpha",
    layer: "poi", className: "museum" }, "رصدخانه نقشه‌نگاری آلفا"), []);
});

test("provider readiness distinguishes reachable engines from configured models", async (context) => {
  preserveEnvironment(context, ["GEMINI_API_KEY", "LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "MADLAD_TRANSLATION_BASE_URL"]);
  delete process.env.GEMINI_API_KEY;
  delete process.env.LOCAL_TRANSLATION_MODEL;
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/v1";
  process.env.MADLAD_TRANSLATION_BASE_URL = "http://madlad.test";
  context.mock.method(globalThis, "fetch", async (url) => String(url).includes("madlad.test")
    ? new Response(JSON.stringify({ ready: true, model: "google/madlad400-3b-mt" }), { status: 200 })
    : new Response(JSON.stringify({ data: [] }), { status: 200 }));

  const statuses = await translationProviderStatuses();
  assert.deepEqual(statuses.map((item) => ({ kind: item.kind, configured: item.configured,
    reachable: item.reachable, ready: item.ready })), [
    { kind: "gemini", configured: false, reachable: null, ready: false },
    { kind: "madlad", configured: true, reachable: true, ready: true },
    { kind: "local", configured: false, reachable: true, ready: false },
  ]);
});

test("provider readiness recognizes a loaded model from the LM Studio native API", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "MADLAD_TRANSLATION_BASE_URL"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-4b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.MADLAD_TRANSLATION_BASE_URL = "http://madlad.test";
  context.mock.method(globalThis, "fetch", async (url) => String(url).includes("madlad.test")
    ? new Response("not found", { status: 404 })
    : new Response(JSON.stringify({ models: [{ key: "qwen3.5-4b",
      loaded_instances: [{ id: "qwen3.5-4b" }] }, { key: "unloaded-model", loaded_instances: [] }] }),
    { status: 200 }));

  const local = (await translationProviderStatuses()).find((item) => item.kind === "local");
  assert.deepEqual({ reachable: local.reachable, modelAvailable: local.modelAvailable, ready: local.ready },
    { reachable: true, modelAvailable: true, ready: true });
});

test("MADLAD provider sends the dedicated translation contract", async (context) => {
  preserveEnvironment(context, ["MADLAD_TRANSLATION_BASE_URL", "MADLAD_TRANSLATION_MODEL"]);
  process.env.MADLAD_TRANSLATION_BASE_URL = "http://madlad.test";
  process.env.MADLAD_TRANSLATION_MODEL = "google/madlad400-3b-mt";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "http://madlad.test/v1/translations");
    const body = JSON.parse(options.body);
    assert.equal(body.target_language, "fa");
    assert.equal(body.items[0].source_name, "Central Station");
    return new Response(JSON.stringify({ provider: "madlad:google/madlad400-3b-mt", translations: [{
      key: "one", translated_name: "ایستگاه مرکزی", strategy: "translation",
    }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "one", sourceName: "Central Station", layer: "transportation_name", className: "station" },
  ], "madlad", { useMemory: false });
  assert.equal(result.provider, "madlad:google/madlad400-3b-mt");
  assert.equal(result.translations[0].translatedName, "ایستگاه مرکزی");
});

test("hybrid provider falls back to the local model when MADLAD is unavailable", async (context) => {
  preserveEnvironment(context, ["MADLAD_TRANSLATION_BASE_URL", "LOCAL_TRANSLATION_MODEL",
    "LOCAL_TRANSLATION_BASE_URL", "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.MADLAD_TRANSLATION_BASE_URL = "http://madlad.test";
  process.env.LOCAL_TRANSLATION_MODEL = "local-test";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("madlad.test")) throw new Error("offline");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{
      key: "one", translated_name: "ویلا لوسیا", strategy: "transliteration",
    }] }) } }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "one", sourceName: "Villa Lucia", layer: "poi", className: "" },
  ], "hybrid", { useMemory: false });
  assert.equal(result.provider, "fallback:local:local-test");
});

test("explicit Gemini selection returns normalized schema output", async (context) => {
  preserveEnvironment(context, ["GEMINI_API_KEY", "GEMINI_TRANSLATION_MODEL"]);
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_TRANSLATION_MODEL = "gemini-test";
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /gemini-test/);
    const text = JSON.stringify({ translations: [{ key: "one", translated_name: "موناکو", strategy: "transliteration" }] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  });

  const result = await translateMapNamesWithProvider([
    { key: "one", sourceName: "Monaco", layer: "place", className: "city" },
  ], "gemini", { useMemory: false });
  assert.equal(result.provider, "google:gemini-test");
  assert.deepEqual(result.translations, [{ key: "one", translatedName: "موناکو",
    strategy: "transliteration" }]);
});

test("local provider splits new names into the configured safe batch size", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.LOCAL_TRANSLATION_MODEL = "local-test";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const requested = JSON.parse(body.messages.at(-1).content).items;
    const translations = requested.map((item) => ({ key: item.key,
      translated_name: item.source_name === "Monaco" ? "موناکو" : "ویلا لوسیا",
      strategy: "transliteration" }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }),
      { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "one", sourceName: "Monaco", layer: "place", className: "country" },
    { key: "two", sourceName: "Villa Lucia", layer: "poi", className: "" },
  ], "local", { useMemory: false });
  assert.equal(calls, 2);
  assert.equal(result.provider, "local:local-test");
  assert.deepEqual(result.translations.map((item) => item.translatedName), ["موناکو", "ویلا لوسیا"]);
});

test("local provider uses LM Studio native chat with reasoning disabled", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-4b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "http://local.test/api/v1/chat");
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning, "off");
    assert.equal(body.store, false);
    return new Response(JSON.stringify({ output: [{ type: "message", content: `\`\`\`json\n${JSON.stringify({ translations: [{
      key: "one", translated_name: "تورنتو", strategy: "transliteration",
    }] })}\n\`\`\`` }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "one", sourceName: "Toronto", layer: "place", className: "city" },
  ], "local", { useMemory: false });
  assert.equal(result.translations[0].translatedName, "تورنتو");
});

test("local provider accepts LM Studio native map-shaped translation output", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-9b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const requested = JSON.parse(JSON.parse(options.body).input).items[0];
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({
      translations: { [requested.key]: "رصدخانه نقشه‌نگاری آلفا" },
    }) }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "unknown", sourceName: "Observatoire Cartographique Alpha", layer: "poi", className: "museum" },
  ], "local", { useMemory: false });
  assert.deepEqual(result.translations.map((item) => ({ name: item.translatedName, strategy: item.strategy })), [
    { name: "رصدخانه نقشه‌نگاری آلفا", strategy: "mixed" },
  ]);
});

test("local provider accepts LM Studio language-nested map output", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-9b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const requested = JSON.parse(JSON.parse(options.body).input).items[0];
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({
      translations: { fa: { [requested.key]: "رصدخانه نقشه‌نگاری آلفا" } },
    }) }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "unknown", sourceName: "Observatoire Cartographique Alpha", layer: "poi", className: "museum" },
  ], "local", { useMemory: false });
  assert.equal(result.translations[0].translatedName, "رصدخانه نقشه‌نگاری آلفا");
});

test("local provider restores a JSON-array key rewritten by LM Studio", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-9b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  const keyParts = ["Observatoire Cartographique Alpha", "poi", "museum", ""];
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output: [{ type: "message", content: JSON.stringify({ translations: [{ key: keyParts,
      translated_name: "رصدخانه نقشه‌نگاری آلفا", strategy: "mixed" }] }) }],
  }), { status: 200 }));
  const result = await translateMapNamesWithProvider([
    { key: JSON.stringify(keyParts), sourceName: keyParts[0], layer: keyParts[1], className: keyParts[2] },
  ], "local", { useMemory: false });
  assert.equal(result.translations[0].translatedName, "رصدخانه نقشه‌نگاری آلفا");
});

test("local provider repairs a semantically incomplete map name once", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "LOCAL_TRANSLATION_BATCH_SIZE", "PROPER_NAME_JUDGE_ENABLED"]);
  process.env.LOCAL_TRANSLATION_MODEL = "qwen3.5-9b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.LOCAL_TRANSLATION_BATCH_SIZE = "1";
  process.env.PROPER_NAME_JUDGE_ENABLED = "false";
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (calls === 2) {
      assert.match(body.input, /Observatoire\/Observatory=رصدخانه/);
      assert.match(body.input, /Cartographique\/Cartographic=نقشه‌نگاری/);
      assert.match(body.input, /Alpha=آلفا/);
    }
    const translated = calls === 1 ? "آلبا، موزه" : "رصدخانه نقشه‌نگاری آلفا";
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({
      translations: { unknown: translated },
    }) }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([
    { key: "unknown", sourceName: "Observatoire Cartographique Alpha", layer: "poi", className: "museum" },
  ], "local", { useMemory: false });
  assert.equal(calls, 2);
  assert.equal(result.translations[0].translatedName, "رصدخانه نقشه‌نگاری آلفا");
});

test("canonical exonyms bypass the model in the normal translation path", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("canonical place must not call a model"));
  const result = await translateMapNamesWithProvider([
    { key: "germany", sourceName: "Deutschland", layer: "place", className: "country" },
    { key: "beijing", sourceName: "北京", layer: "place", className: "city" },
  ], "local");
  assert.equal(result.provider, "canonical-place-memory");
  assert.deepEqual(result.translations.map((item) => ({ name: item.translatedName, provider: item.provider })), [
    { name: "آلمان", provider: "canonical-place-memory" },
    { name: "پکن", provider: "canonical-place-memory" },
  ]);
  assert.deepEqual(result.memory, { hits: 0, canonicalHits: 2, controlledHits: 0, misses: 0 });
});

test("client-approved identity memory takes precedence over the general canonical gazetteer", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("approved identity must not call a model"));
  const approvedMemory = { resolve: async (items) => new Map([[items[0].key, {
    key: items[0].key, translatedName: "ترجمهٔ مورد تأیید کارفرما", strategy: "mixed",
    provider: "approved-identity-memory", canonicalId: "wikidata:Q235",
    reviewRequired: false, automaticApproval: "client-approved-identity",
  }]]) };
  const canonicalResolver = { resolve: (items) => {
    assert.deepEqual(items, []);
    return new Map();
  } };
  const result = await translateMapNamesWithProvider([
    { key: "monaco", sourceName: "Monaco", layer: "place", className: "country", wikidataId: "Q235" },
  ], "local", { approvedMemory, canonicalResolver });
  assert.equal(result.translations[0].translatedName, "ترجمهٔ مورد تأیید کارفرما");
  assert.equal(result.translations[0].provider, "approved-identity-memory");
  assert.deepEqual(result.memory, { hits: 1, canonicalHits: 0, controlledHits: 0, misses: 0 });
});

test("canonical composite place names bypass the model", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("canonical composite must not call a model"));
  const result = await translateMapNamesWithProvider([
    { key: "station", sourceName: "東京駅", layer: "transportation_name", className: "station" },
    { key: "airport", sourceName: "Beijing International Airport", layer: "poi", className: "airport" },
  ], "local");
  assert.equal(result.provider, "canonical-place-composite");
  assert.deepEqual(result.translations.map((item) => item.translatedName),
    ["ایستگاه توکیو", "فرودگاه بین‌المللی پکن"]);
  assert.deepEqual(result.memory, { hits: 0, canonicalHits: 2, controlledHits: 0, misses: 0 });
});

test("canonical physical names bypass the model", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("canonical physical name must not call a model"));
  const result = await translateMapNamesWithProvider([
    { key: "gulf", sourceName: "Persian Gulf", layer: "water_name", className: "gulf" },
    { key: "river", sourceName: "Nile", layer: "water_name", className: "river" },
  ], "local");
  assert.equal(result.provider, "canonical-place-memory");
  assert.deepEqual(result.translations.map((item) => item.translatedName), ["خلیج فارس", "رود نیل"]);
  assert.deepEqual(result.memory, { hits: 0, canonicalHits: 2, controlledHits: 0, misses: 0 });
});

test("controlled generic names and identifiers bypass the model", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("controlled names must not call a model"));
  const result = await translateMapNamesWithProvider([
    { key: "generic", sourceName: "Impasse", layer: "transportation_name", className: "minor" },
    { key: "identifier", sourceName: "A2-A3", layer: "building", className: "building" },
  ], "madlad");
  assert.deepEqual(result.translations.map((item) => ({ name: item.translatedName,
    provider: item.provider, reviewRequired: item.reviewRequired })), [
    { name: "بن‌بست", provider: "controlled-generic-memory", reviewRequired: false },
    { name: "A2-A3", provider: "identifier-preserved", reviewRequired: false },
  ]);
  assert.equal(result.memory.controlledHits, 2);
});

test("model generated proper and mixed names require a judge before persistence", async (context) => {
  preserveEnvironment(context, ["MADLAD_TRANSLATION_BASE_URL", "PROPER_NAME_JUDGE_ENABLED"]);
  process.env.MADLAD_TRANSLATION_BASE_URL = "http://madlad.test";
  process.env.PROPER_NAME_JUDGE_ENABLED = "false";
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    provider: "madlad:test", translations: [
      { key: "proper", translated_name: "دیور", strategy: "transliteration" },
      { key: "mixed", translated_name: "خیابان روکویل", strategy: "mixed" },
    ],
  }), { status: 200 }));
  const result = await translateMapNamesWithProvider([
    { key: "proper", sourceName: "Dior", layer: "poi", className: "shop" },
    { key: "mixed", sourceName: "Avenue de Roqueville", layer: "transportation_name", className: "road" },
  ], "madlad");
  assert.deepEqual(result.translations.map((item) => ({ kind: item.nameKind,
    reviewRequired: item.reviewRequired })), [
    { kind: "proper", reviewRequired: true }, { kind: "mixed", reviewRequired: true },
  ]);
});

test("two distinct judge models report consensus without automatically approving a generated proper name", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL",
    "PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL", "PROPER_NAME_JUDGE_MODEL",
    "PROPER_NAME_JUDGE_SECONDARY_MODEL"]);
  process.env.LOCAL_TRANSLATION_MODEL = "translator-9b";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://local.test/api/v1";
  process.env.PROPER_NAME_JUDGE_MODEL = "judge-4b";
  process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL = "judge-9b";
  const requestedJudges = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    if (String(body.system_prompt).includes("داور محافظه‌کار")) {
      requestedJudges.push(body.model);
      const requested = JSON.parse(body.input).items[0];
      return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
        key: requested.key, decision: "accept", corrected: requested.candidate, reason_code: "none",
      }] }) }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ translations: [{
      key: "proper", translated_name: "راوین دو سنت دِووت", strategy: "transliteration",
    }] }) }] }), { status: 200 });
  });
  const result = await translateMapNamesWithProvider([{ key: "proper", sourceName: "Ravin de Sainte-Dévote",
    layer: "place", className: "suburb", wikidataId: "Q18635826" }], "local");
  assert.deepEqual(requestedJudges, ["judge-4b", "judge-9b"]);
  assert.equal(result.translations[0].reviewRequired, true);
  assert.equal(result.translations[0].automaticApproval, undefined);
  assert.equal(result.translations[0].judge.consensus, true);
  assert.equal(result.translations[0].judge.mode, "advisory-consensus");
});

test("an unresolved Wikidata identity bypasses approved memory and reaches the model", async (context) => {
  preserveEnvironment(context, ["LOCAL_TRANSLATION_MODEL", "LOCAL_TRANSLATION_BASE_URL", "PROPER_NAME_JUDGE_ENABLED"]);
  process.env.LOCAL_TRANSLATION_MODEL = "local-test";
  process.env.LOCAL_TRANSLATION_BASE_URL = "http://local.test/api/v1";
  process.env.PROPER_NAME_JUDGE_ENABLED = "false";
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ output: [{ type: "message", content:
      '{"translations":[{"key":"unknown-id","translated_name":"باغ اگزوتیک","strategy":"mixed"}]}' }] }),
    { status: 200 });
  });
  const result = await translateMapNamesWithProvider([{ key: "unknown-id", sourceName: "Jardin Exotique",
    layer: "place", className: "suburb", wikidataId: "Q19286504" }], "local");
  assert.equal(calls, 1);
  assert.equal(result.translations[0].provider, "local:local-test");
  assert.equal(result.translations[0].reviewRequired, true);
  assert.equal(result.memory.hits, 0);
  assert.equal(result.memory.misses, 1);
});
