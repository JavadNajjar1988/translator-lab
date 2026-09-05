import { approvedTranslationMemory } from "./translation-memory.mjs";
import { canonicalPlaceNames } from "./canonical-place-names.mjs";
import { classifyMapName, resolveControlledNames } from "./proper-name-router.mjs";
import { detectSourceScript } from "./source-script.mjs";
import { judgeProperNameTranslations } from "./proper-name-judge.mjs";
import { translationQualityIssues } from "./translation-quality.mjs";

export { translationQualityIssues } from "./translation-quality.mjs";

const batchSchema = {
  type: "object", additionalProperties: false,
  properties: { translations: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { key: { type: "string" }, translated_name: { type: "string" },
      strategy: { type: "string", enum: ["translation", "transliteration", "mixed"] } },
    required: ["key", "translated_name", "strategy"] } } }, required: ["translations"],
};

const instructions = `نام عوارض نقشه را به فارسی معیار برگردان. نام خاص را با املای رایج فارسی آوانویسی کن، اما واژه‌های عمومی جغرافیایی را حتماً ترجمه کن و حرف اضافه و تعریف فرانسوی را آوانویسی نکن. این واژه‌نامه الزام‌آور است: Avenue و Rue برابر خیابان، Boulevard برابر بلوار، Impasse برابر بن‌بست، Stade برابر ورزشگاه، Parking برابر پارکینگ، Gare برابر ایستگاه، Hôpital برابر بیمارستان، Jardin برابر باغ، Port برابر بندر، Pont برابر پل، Place برابر میدان، Plage برابر ساحل و Chemin برابر مسیر است. از صورت‌هایی مانند آونیو، آوینیو، ژاردن، پلاس، استاد برای Stade و پورت برای Port عمومی استفاده نکن. شناسه‌های ساختمانی مانند A2-A3 را عیناً حفظ کن. بافت لایه و کلاس را در انتخاب واژه در نظر بگیر. هر کلید ورودی را دقیقاً یک بار برگردان و هیچ توضیح اضافه‌ای ننویس.`;

export class TranslationProviderError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function normalizeOutput(value, expectedKeys) {
  if (!value || typeof value !== "object") throw new TranslationProviderError("ساختار خروجی ترجمه معتبر نبود.");
  const translationValue = value.translations?.fa && typeof value.translations.fa === "object"
    ? value.translations.fa : value.translations;
  const rawTranslations = Array.isArray(translationValue) ? translationValue
    : translationValue && typeof translationValue === "object"
      ? Object.entries(translationValue).map(([key, item]) => typeof item === "string"
        ? { key, translated_name: item, strategy: "mixed" }
        : { key, ...item })
      : [];
  const translations = rawTranslations.map((item) => ({ ...item,
    key: Array.isArray(item.key) ? JSON.stringify(item.key) : item.key }))
    .filter((item) => item.key && expectedKeys.has(item.key)
      && typeof item.translated_name === "string" && item.translated_name.trim())
    .map((item) => ({ key: item.key, translatedName: item.translated_name.trim(),
      strategy: ["translation", "transliteration", "mixed"].includes(item.strategy) ? item.strategy : "mixed" }));
  if (translations.length !== expectedKeys.size || new Set(translations.map((item) => item.key)).size !== expectedKeys.size) {
    throw new TranslationProviderError("ارائه‌دهنده برای همهٔ نام‌های دسته خروجی معتبر برنگرداند.");
  }
  return translations;
}

function requestPayload(items, repairNotes) {
  return JSON.stringify({ target_language: "fa", items: items.map((item) => ({
    key: item.key, source_name: item.sourceName, layer: item.layer, class: item.className,
    ...(repairNotes?.has(item.key) ? { repair_requirement: repairNotes.get(item.key) } : {}),
  })) });
}

function geminiText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
}

async function requestGeminiBatch(items, apiKey, model, repairNotes) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: requestPayload(items, repairNotes) }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: batchSchema } }),
  });
  if (!response.ok) {
    const detail = await response.text();
    const message = response.status === 400 ? "تنظیمات درخواست جمنای معتبر نیست." :
      response.status === 401 || response.status === 403 ? "کلید جمنای معتبر نیست یا دسترسی لازم را ندارد." :
      response.status === 429 ? "سهمیهٔ جمنای موقتاً به پایان رسیده است." : "جمنای پاسخ معتبر نداد.";
    console.error("Gemini translation error", response.status, detail.slice(0, 500));
    throw new TranslationProviderError(message, response.status === 429 ? 429 : 502);
  }
  const text = geminiText(await response.json());
  if (!text) throw new TranslationProviderError("خروجی جمنای خالی بود.");
  try { return normalizeOutput(JSON.parse(text), new Set(items.map((item) => item.key))); }
  catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw new TranslationProviderError("خروجی جمنای قابل خواندن نبود.");
  }
}

async function translateWithGemini(items) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new TranslationProviderError("کلید جمنای هنوز تنظیم نشده است.", 503);
  const model = process.env.GEMINI_TRANSLATION_MODEL?.trim() || "gemini-3.5-flash-lite";
  const first = await requestGeminiBatch(items, apiKey, model);
  const byKey = new Map(first.map((item) => [item.key, item]));
  const invalid = items.filter((item) => translationQualityIssues(item, byKey.get(item.key)?.translatedName || "").length);
  if (invalid.length) {
    const notes = new Map(invalid.map((item) => [item.key,
      `خروجی باید این قواعد را رعایت کند: ${translationQualityIssues(item, byKey.get(item.key)?.translatedName || "").join("، ")}`]));
    (await requestGeminiBatch(invalid, apiKey, model, notes)).forEach((item) => byKey.set(item.key, item));
  }
  if (items.some((item) => translationQualityIssues(item, byKey.get(item.key)?.translatedName || "").length)) {
    throw new TranslationProviderError("خروجی ترجمه با واژه‌نامهٔ کنترل کیفیت سازگار نبود.");
  }
  return { translations: items.map((item) => byKey.get(item.key)), provider: `google:${model}` };
}

function openAiText(payload) {
  if (payload?.output_text) return payload.output_text;
  for (const item of payload?.output || []) for (const content of item.content || []) {
    if (content.type === "output_text" && content.text) return content.text;
  }
  return "";
}

async function translateWithOpenAI(items) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new TranslationProviderError("کلید مدل اوپن‌ای‌آی هنوز تنظیم نشده است.", 503);
  const model = process.env.OPENAI_TRANSLATION_MODEL?.trim() || "gpt-5.4-nano";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, store: false, instructions, input: requestPayload(items),
      text: { format: { type: "json_schema", name: "map_name_translation_batch", strict: true, schema: batchSchema } },
      max_output_tokens: Math.max(600, items.length * 90) }),
  });
  if (!response.ok) throw new TranslationProviderError("ارائه‌دهندهٔ اوپن‌ای‌آی پاسخ معتبر نداد.");
  const text = openAiText(await response.json());
  if (!text) throw new TranslationProviderError("خروجی اوپن‌ای‌آی خالی بود.");
  try { return { translations: normalizeOutput(JSON.parse(text), new Set(items.map((item) => item.key))), provider: `openai:${model}` }; }
  catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw new TranslationProviderError("خروجی اوپن‌ای‌آی قابل خواندن نبود.");
  }
}

function localText(payload) {
  return payload?.choices?.[0]?.message?.content?.trim() || "";
}

function localNativeText(payload) {
  return (payload?.output || []).filter((item) => item?.type === "message")
    .map((item) => item.content || "").join("").trim();
}

function parseLocalJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("invalid_local_json");
  }
}

async function requestLocalBatch(items, repairNotes) {
  const baseUrl = (process.env.LOCAL_TRANSLATION_BASE_URL || "http://127.0.0.1:1234/api/v1").replace(/\/$/, "");
  const model = process.env.LOCAL_TRANSLATION_MODEL?.trim();
  if (!model) throw new TranslationProviderError("نام مدل محلی هنوز تنظیم نشده است.", 503);
  const apiKey = process.env.LOCAL_TRANSLATION_API_KEY?.trim() || "local";
  const nativeApi = /\/api\/v1$/i.test(baseUrl);
  const userInput = requestPayload(items, repairNotes);
  const body = nativeApi
    ? { model, input: userInput,
      system_prompt: `${instructions}\nساختار دقیق خروجی: {"translations":[{"key":"کلید ورودی","translated_name":"نام فارسی","strategy":"translation|transliteration|mixed"}]}`,
      reasoning: "off", store: false,
      temperature: 0, top_k: 20, max_output_tokens: Math.max(220, items.length * 100) }
    : { model, temperature: 0, max_tokens: Math.max(220, items.length * 100),
      chat_template_kwargs: { enable_thinking: false }, messages: [
        { role: "system", content: `${instructions}\n/no_think` },
        { role: "user", content: userInput },
      ], response_format: { type: "json_schema", json_schema: {
        name: "map_name_translation_batch", strict: true, schema: batchSchema } } };
  let response;
  try {
    response = await fetch(`${baseUrl}${nativeApi ? "/chat" : "/chat/completions"}`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify(body),
    });
  } catch {
    throw new TranslationProviderError("سرویس مدل محلی در دسترس نیست.", 503);
  }
  if (!response.ok) throw new TranslationProviderError("مدل محلی پاسخ معتبر نداد.", 502);
  const payload = await response.json();
  const text = nativeApi ? localNativeText(payload) : localText(payload);
  if (!text) throw new TranslationProviderError("خروجی مدل محلی خالی بود.");
  if (process.env.TRANSLATION_DEBUG_OUTPUT === "true") {
    console.error("Local translation raw output:", text.slice(0, 4_000));
  }
  try {
    return normalizeOutput(parseLocalJson(text), new Set(items.map((item) => item.key)));
  } catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw new TranslationProviderError("خروجی مدل محلی قابل خواندن نبود.");
  }
}

async function translateLocalBatch(items) {
  const model = process.env.LOCAL_TRANSLATION_MODEL?.trim();
  const first = await requestLocalBatch(items);
  const byKey = new Map(first.map((item) => [item.key, item]));
  const invalid = items.filter((item) => translationQualityIssues(item,
    byKey.get(item.key)?.translatedName || "").length);
  if (invalid.length) {
    const notes = new Map(invalid.map((item) => [item.key,
      `خروجی باید این قواعد را رعایت کند: ${translationQualityIssues(item,
        byKey.get(item.key)?.translatedName || "").join("، ")}`]));
    (await requestLocalBatch(invalid, notes)).forEach((item) => byKey.set(item.key, item));
  }
  if (items.some((item) => translationQualityIssues(item,
    byKey.get(item.key)?.translatedName || "").length)) {
    throw new TranslationProviderError("خروجی مدل محلی با واژه‌نامهٔ کنترل کیفیت سازگار نبود.");
  }
  return { translations: items.map((item) => byKey.get(item.key)), provider: `local:${model}` };
}

async function translateWithLocalModel(items) {
  const batchSize = Math.max(1, Math.min(20,
    Number.parseInt(process.env.LOCAL_TRANSLATION_BATCH_SIZE || "1", 10) || 1));
  const translations = [];
  let provider = `local:${process.env.LOCAL_TRANSLATION_MODEL?.trim() || ""}`;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const output = await translateLocalBatch(items.slice(offset, offset + batchSize));
    provider = output.provider;
    translations.push(...output.translations);
  }
  return { translations, provider };
}

async function requestMadladBatch(items) {
  const baseUrl = (process.env.MADLAD_TRANSLATION_BASE_URL || "http://127.0.0.1:3007").replace(/\/$/, "");
  const model = process.env.MADLAD_TRANSLATION_MODEL?.trim() || "google/madlad400-3b-mt";
  const timeoutMs = Math.max(10_000, Number.parseInt(process.env.MADLAD_TRANSLATION_TIMEOUT_MS || "180000", 10) || 180_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/translations`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ target_language: "fa", items: items.map((item) => ({
        key: item.key, source_name: item.sourceName, layer: item.layer, class: item.className,
      })) }),
    });
  } catch {
    throw new TranslationProviderError("سرویس تخصصی ترجمهٔ آفلاین در دسترس نیست.", 503);
  }
  if (!response.ok) throw new TranslationProviderError("مدل تخصصی ترجمهٔ آفلاین پاسخ معتبر نداد.", 502);
  let payload;
  try { payload = await response.json(); }
  catch { throw new TranslationProviderError("خروجی مدل تخصصی ترجمه قابل خواندن نبود."); }
  const translations = normalizeOutput(payload, new Set(items.map((item) => item.key)));
  if (items.some((item) => translationQualityIssues(item,
    translations.find((translation) => translation.key === item.key)?.translatedName || "").length)) {
    throw new TranslationProviderError("خروجی مدل تخصصی با واژه‌نامهٔ کنترل کیفیت سازگار نبود.");
  }
  return { translations, provider: payload.provider || `madlad:${model}` };
}

async function translateWithMadlad(items) {
  const batchSize = Math.max(1, Math.min(20,
    Number.parseInt(process.env.MADLAD_TRANSLATION_BATCH_SIZE || "20", 10) || 20));
  const translations = [];
  let provider = `madlad:${process.env.MADLAD_TRANSLATION_MODEL?.trim() || "google/madlad400-3b-mt"}`;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const output = await requestMadladBatch(items.slice(offset, offset + batchSize));
    provider = output.provider;
    translations.push(...output.translations);
  }
  return { translations, provider };
}

async function translateWithHybridModel(items) {
  try {
    return await translateWithMadlad(items);
  } catch (madladError) {
    if (!process.env.LOCAL_TRANSLATION_MODEL?.trim()) throw madladError;
    try {
      const fallback = await translateWithLocalModel(items);
      return { ...fallback, provider: `fallback:${fallback.provider}` };
    } catch {
      throw madladError;
    }
  }
}

function normalizedProvider(provider) {
  return String(provider || "gemini").trim().toLowerCase();
}

function hitProviders(hits) {
  return [...new Set([...hits.values()].map((item) => item.provider).filter(Boolean))];
}

async function translateUncachedMapNamesWithProvider(items, requestedProvider) {
  const provider = normalizedProvider(requestedProvider);
  if (provider === "openai") return translateWithOpenAI(items);
  if (["local", "ollama", "lmstudio", "lm-studio"].includes(provider)) return translateWithLocalModel(items);
  if (["madlad", "madlad400", "madlad-400"].includes(provider)) return translateWithMadlad(items);
  if (provider === "hybrid") return translateWithHybridModel(items);
  if (provider === "gemini") return translateWithGemini(items);
  throw new TranslationProviderError("ارائه‌دهندهٔ ترجمه در تنظیمات شناخته‌شده نیست.", 500);
}

export async function translateMapNamesWithProvider(items, requestedProvider, options = {}) {
  if (options.useMemory === false) return translateUncachedMapNamesWithProvider(items, requestedProvider);
  const known = await resolveKnownMapNames(items, options);
  const { memoryHits, canonicalHits, controlledHits, missing } = known;
  const canonicalProviders = hitProviders(canonicalHits);
  const memoryProviders = hitProviders(memoryHits);
  const controlledProviders = hitProviders(controlledHits);
  if (!missing.length) return known.result;
  const generated = await translateUncachedMapNamesWithProvider(missing, requestedProvider);
  const missingByKey = new Map(missing.map((item) => [item.key, item]));
  const classifiedGenerated = generated.translations.map((item) => {
    const sourceItem = missingByKey.get(item.key);
    const classification = classifyMapName(sourceItem);
    const sourceScript = detectSourceScript(sourceItem?.sourceName ?? sourceItem?.source_name);
    return { ...item, provider: item.provider || generated.provider,
      nameKind: classification.kind, properCore: classification.properCore || undefined,
      sourceScript, reviewRequired: classification.requiresJudge };
  });
  const judgeCandidates = classifiedGenerated.filter((item) => item.reviewRequired);
  const judgeResult = await judgeProperNameTranslations(missing, judgeCandidates);
  const generatedByKey = new Map(classifiedGenerated.map((item) => {
    const judgement = judgeResult?.judgements.get(item.key);
    return [item.key, { ...item,
      ...(judgement ? { judge: { provider: judgeResult.provider,
        mode: "advisory-consensus", ...judgement } } : {}) }];
  }));
  return {
    translations: items.map((item) => memoryHits.get(item.key) || canonicalHits.get(item.key)
      || controlledHits.get(item.key) || generatedByKey.get(item.key)),
    provider: [...memoryProviders, ...canonicalProviders, ...controlledProviders,
      generated.provider].filter(Boolean).join("+"),
    memory: { hits: memoryHits.size, canonicalHits: canonicalHits.size,
      controlledHits: controlledHits.size, misses: missing.length },
    ...(judgeResult ? { judge: { provider: judgeResult.provider, mode: "advisory-consensus",
      status: judgeResult.status, reviewed: judgeResult.judgements.size } } : {}),
  };
}

async function resolveKnownMapNames(items, options = {}) {
  const approvedMemory = options.approvedMemory || approvedTranslationMemory;
  const canonicalResolver = options.canonicalResolver || canonicalPlaceNames;
  const memoryHits = await approvedMemory.resolve(items);
  const afterApprovedMemory = items.filter((item) => !memoryHits.has(item.key));
  const canonicalHits = canonicalResolver.resolve(afterApprovedMemory);
  const afterCanonicalMemory = afterApprovedMemory.filter((item) => !canonicalHits.has(item.key));
  const controlledHits = resolveControlledNames(afterCanonicalMemory);
  const missing = afterCanonicalMemory.filter((item) => !controlledHits.has(item.key));
  const canonicalProviders = hitProviders(canonicalHits);
  const memoryProviders = hitProviders(memoryHits);
  const controlledProviders = hitProviders(controlledHits);
  const result = { translations: items.map((item) => memoryHits.get(item.key) || canonicalHits.get(item.key)
    || controlledHits.get(item.key)).filter(Boolean),
    provider: [...memoryProviders, ...canonicalProviders, ...controlledProviders].filter(Boolean).join("+"),
    memory: { hits: memoryHits.size, canonicalHits: canonicalHits.size,
      controlledHits: controlledHits.size, misses: missing.length }, deterministicOnly: true };
  return { memoryHits, canonicalHits, controlledHits, missing, result };
}

export async function translateKnownMapNames(items, options = {}) {
  return (await resolveKnownMapNames(items, options)).result;
}

export async function approvedTranslationMemoryStatus() {
  await approvedTranslationMemory.load();
  return approvedTranslationMemory.status();
}

export function canonicalPlaceNameStatus() {
  return canonicalPlaceNames.status();
}

export async function translateMapNames(items) {
  return translateMapNamesWithProvider(items, process.env.TRANSLATION_PROVIDER || "gemini");
}

export function translationProviderStatus(requestedProvider = process.env.TRANSLATION_PROVIDER || "gemini") {
  const provider = normalizedProvider(requestedProvider);
  if (provider === "gemini") return { kind: "gemini", model: process.env.GEMINI_TRANSLATION_MODEL?.trim()
    || "gemini-3.5-flash-lite", configured: Boolean(process.env.GEMINI_API_KEY?.trim()) };
  if (provider === "openai") return { kind: "openai", model: process.env.OPENAI_TRANSLATION_MODEL?.trim()
    || "gpt-5.4-nano", configured: Boolean(process.env.OPENAI_API_KEY?.trim()) };
  if (["local", "ollama", "lmstudio", "lm-studio"].includes(provider)) return { kind: "local",
    model: process.env.LOCAL_TRANSLATION_MODEL?.trim() || "", configured: Boolean(process.env.LOCAL_TRANSLATION_MODEL?.trim()) };
  if (["madlad", "madlad400", "madlad-400"].includes(provider)) return { kind: "madlad",
    model: process.env.MADLAD_TRANSLATION_MODEL?.trim() || "google/madlad400-3b-mt", configured: true };
  if (provider === "hybrid") return { kind: "hybrid",
    model: `${process.env.MADLAD_TRANSLATION_MODEL?.trim() || "google/madlad400-3b-mt"} + ${process.env.LOCAL_TRANSLATION_MODEL?.trim() || "fallback disabled"}`,
    configured: true };
  return { kind: provider || "unknown", model: "", configured: false };
}

export async function translationProviderStatuses() {
  const gemini = translationProviderStatus("gemini");
  const madlad = translationProviderStatus("madlad");
  const local = translationProviderStatus("local");
  const baseUrl = (process.env.LOCAL_TRANSLATION_BASE_URL || "http://127.0.0.1:1234/api/v1").replace(/\/$/, "");
  let reachable = false;
  let modelAvailable = false;
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2_500),
      headers: { authorization: `Bearer ${process.env.LOCAL_TRANSLATION_API_KEY?.trim() || "local"}` } });
    if (response.ok) {
      reachable = true;
      const payload = await response.json();
      const openAiModels = (payload?.data || []).map((item) => item?.id).filter(Boolean);
      const nativeModels = (payload?.models || []).filter((item) => !Array.isArray(item?.loaded_instances)
        || item.loaded_instances.length > 0).flatMap((item) => [item?.key,
          ...(item?.loaded_instances || []).map((instance) => instance?.id)]).filter(Boolean);
      const models = new Set([...openAiModels, ...nativeModels]);
      modelAvailable = Boolean(local.model && models.has(local.model));
    }
  } catch {
    reachable = false;
    modelAvailable = false;
  }
  const madladBaseUrl = (process.env.MADLAD_TRANSLATION_BASE_URL || "http://127.0.0.1:3007").replace(/\/$/, "");
  let madladReachable = false;
  let madladModelAvailable = false;
  try {
    const response = await fetch(`${madladBaseUrl}/health`, { signal: AbortSignal.timeout(2_500) });
    if (response.ok) {
      madladReachable = true;
      const payload = await response.json();
      madladModelAvailable = payload?.ready === true && (!payload.model || payload.model === madlad.model);
    }
  } catch {
    madladReachable = false;
    madladModelAvailable = false;
  }
  return [
    { ...gemini, reachable: null, modelAvailable: gemini.configured, ready: gemini.configured },
    { ...madlad, reachable: madladReachable, modelAvailable: madladModelAvailable,
      ready: madlad.configured && madladReachable && madladModelAvailable },
    { ...local, reachable, modelAvailable, ready: local.configured && reachable && modelAvailable },
  ];
}

export async function compareMapNameTranslations(items) {
  const statuses = await translationProviderStatuses();
  const results = await Promise.all(statuses.map(async (status) => {
    const startedAt = Date.now();
    if (!status.ready) {
      const error = status.kind === "local" && !status.configured ? "نام مدل محلی هنوز تنظیم نشده است."
        : status.kind === "local" && !status.reachable ? "سرویس مدل محلی در دسترس نیست."
        : status.kind === "local" ? "مدل محلی تنظیم‌شده در سرویس بارگیری نشده است."
        : status.kind === "madlad" && !status.reachable ? "سرویس تخصصی ترجمهٔ آفلاین در دسترس نیست."
        : status.kind === "madlad" ? "مدل تخصصی ترجمه هنوز بارگیری نشده است."
        : "ارائه‌دهنده هنوز تنظیم نشده است.";
      return { ...status, ok: false, durationMs: 0, error };
    }
    try {
      const output = await translateMapNamesWithProvider(items, status.kind, { useMemory: false });
      return { ...status, ok: true, durationMs: Date.now() - startedAt,
        provider: output.provider, translations: output.translations };
    } catch (error) {
      return { ...status, ok: false, durationMs: Date.now() - startedAt,
        error: error instanceof TranslationProviderError ? error.message : "ترجمه با این مدل انجام نشد." };
    }
  }));
  return { results };
}
