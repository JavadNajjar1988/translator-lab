import { translationQualityIssues } from "./translation-quality.mjs";

const judgeInstructions = `تو داور محافظه‌کار برچسب فارسی نقشه هستی. فقط JSON فشرده برگردان.
نام خاص یا نشان تجاری ناشناخته را بدون مدرک اصلاح نکن. اگر نامزد، هویت نام خاص را به‌طور معقول حفظ کرده و نام مرجع مخالفی داده نشده است، آن را بپذیر.
نام مرجع داده‌شده الزام‌آور است. واژه‌های عمومی باید ترجمه شوند: Avenue و Rue برابر خیابان، Boulevard برابر بلوار، Impasse برابر بن‌بست، Stade و Stadium برابر ورزشگاه، Gare و Station برابر ایستگاه، Hôpital و Hospital برابر بیمارستان، Jardin و Garden برابر باغ، Port برابر بندر، Pont و Bridge برابر پل، Place و Square برابر میدان، Plage و Beach برابر ساحل است.
ساختار خروجی دقیقاً چنین است: {"items":[{"key":"string","decision":"accept|correct|reject","corrected":"string","reason_code":"generic_term|authoritative_name|identity_loss|none"}]}`;

function enabled() {
  return String(process.env.PROPER_NAME_JUDGE_ENABLED || "false").trim().toLowerCase() === "true";
}

function messageText(payload) {
  return (payload?.output || []).filter((item) => item?.type === "message")
    .map((item) => item.content || "").join("").trim();
}

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeJudgements(payload, expected) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const byKey = new Map();
  for (const item of items) {
    const candidate = expected.get(item?.key);
    if (!candidate || byKey.has(item.key)) continue;
    const decision = ["accept", "correct", "reject"].includes(item.decision) ? item.decision : "invalid";
    const corrected = normalized(item.corrected);
    const candidateName = normalized(candidate.translatedName);
    const consistent = decision !== "invalid" && ((decision === "accept"
      && (!corrected || corrected === candidateName)) || (decision === "correct"
      && corrected && corrected !== candidateName) || decision === "reject");
    byKey.set(item.key, { decision: consistent ? decision : "invalid",
      ...(!consistent ? { rawDecision: item.decision } : {}), suggestedName: corrected || candidateName,
      reasonCode: typeof item.reason_code === "string" ? item.reason_code : "invalid_output" });
  }
  for (const key of expected.keys()) if (!byKey.has(key)) byKey.set(key, {
    decision: "invalid", suggestedName: expected.get(key).translatedName, reasonCode: "missing_output",
  });
  return byKey;
}

async function judgeWithModel(sourceItems, translations, model) {
  const baseUrl = (process.env.PROPER_NAME_JUDGE_BASE_URL || "http://127.0.0.1:1234/api/v1").replace(/\/$/, "");
  const sources = new Map(sourceItems.map((item) => [item.key, item]));
  const expected = new Map(translations.map((translation) => [translation.key, translation]));
  const input = JSON.stringify({ items: translations.map((translation) => {
    const source = sources.get(translation.key) || {};
    return { key: translation.key, source: source.sourceName || "", candidate: translation.translatedName,
      layer: source.layer || "", class: source.className || "" };
  }) });
  try {
    const response = await fetch(`${baseUrl}/chat`, { method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(Math.max(10_000,
        Number.parseInt(process.env.PROPER_NAME_JUDGE_TIMEOUT_MS || "120000", 10) || 120_000)),
      body: JSON.stringify({ model, input, system_prompt: judgeInstructions, reasoning: "off", store: false,
        temperature: 0, top_k: 20, max_output_tokens: Math.max(300, translations.length * 100) }) });
    if (!response.ok) return { provider: `local-judge:${model}`, status: "unavailable", judgements: new Map() };
    const text = messageText(await response.json());
    if (!text) return { provider: `local-judge:${model}`, status: "invalid", judgements: new Map() };
    let payload;
    try { payload = JSON.parse(text); }
    catch {
      return { provider: `local-judge:${model}`, status: "invalid",
        judgements: new Map([...expected].map(([key, candidate]) => [key, { decision: "invalid",
          suggestedName: candidate.translatedName, reasonCode: "invalid_json" }])) };
    }
    const judgements = normalizeJudgements(payload, expected);
    return { provider: `local-judge:${model}`,
      status: [...judgements.values()].some((item) => item.decision === "invalid") ? "invalid" : "observed",
      judgements };
  } catch {
    return { provider: `local-judge:${model}`, status: "unavailable", judgements: new Map() };
  }
}

function vote(model, judgement) {
  return { model, decision: judgement?.decision || "invalid",
    suggestedName: judgement?.suggestedName || "", reasonCode: judgement?.reasonCode || "missing_output" };
}

function consensusJudgement(candidate, primaryModel, primary, secondaryModel, secondary) {
  const votes = [vote(primaryModel, primary), vote(secondaryModel, secondary)];
  if (primary?.decision === "accept" && secondary?.decision === "accept") return {
    decision: "accept", suggestedName: candidate.translatedName, reasonCode: "consensus_accept",
    consensus: true, votes,
  };
  if (primary?.decision === "invalid" || secondary?.decision === "invalid") return {
    decision: "invalid", suggestedName: candidate.translatedName, reasonCode: "judge_invalid",
    consensus: false, votes,
  };
  return { decision: "reject", suggestedName: secondary?.suggestedName || primary?.suggestedName
      || candidate.translatedName, reasonCode: "judge_disagreement", consensus: false, votes };
}

async function judgeBatch(sourceItems, translations) {
  const primaryModel = process.env.PROPER_NAME_JUDGE_MODEL?.trim() || "qwen3.5-4b";
  const secondaryModel = process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL?.trim() || "";
  const primary = await judgeWithModel(sourceItems, translations, primaryModel);
  if (!secondaryModel || secondaryModel === primaryModel) return primary;

  const accepted = translations.filter((candidate) => primary.judgements.get(candidate.key)?.decision === "accept");
  const secondary = accepted.length ? await judgeWithModel(sourceItems, accepted, secondaryModel) : null;
  const judgements = new Map();
  for (const candidate of translations) {
    const first = primary.judgements.get(candidate.key) || { decision: "invalid",
      suggestedName: candidate.translatedName, reasonCode: "missing_output" };
    if (first.decision !== "accept") {
      judgements.set(candidate.key, { ...first, consensus: false, votes: [vote(primaryModel, first)] });
      continue;
    }
    const second = secondary?.judgements.get(candidate.key) || { decision: "invalid",
      suggestedName: candidate.translatedName,
      reasonCode: secondary?.status === "unavailable" ? "judge_unavailable" : "missing_output" };
    judgements.set(candidate.key,
      consensusJudgement(candidate, primaryModel, first, secondaryModel, second));
  }
  const status = primary.status === "unavailable" || secondary?.status === "unavailable" ? "unavailable"
    : [...judgements.values()].some((item) => item.decision === "invalid") ? "invalid" : "observed";
  return { provider: `local-judge-consensus:${primaryModel}+${secondaryModel}`, status, judgements };
}

async function judgeModelTranslations(sourceItems, translations) {
  const batchSize = Math.max(1, Math.min(10,
    Number.parseInt(process.env.PROPER_NAME_JUDGE_BATCH_SIZE || "1", 10) || 1));
  if (translations.length <= batchSize) return judgeBatch(sourceItems, translations);
  const sourceByKey = new Map(sourceItems.map((item) => [item.key, item]));
  const judgements = new Map();
  const statuses = [];
  let provider = "";
  for (let offset = 0; offset < translations.length; offset += batchSize) {
    const batch = translations.slice(offset, offset + batchSize);
    const output = await judgeBatch(batch.map((item) => sourceByKey.get(item.key)).filter(Boolean), batch);
    provider = output.provider;
    statuses.push(output.status);
    output.judgements.forEach((value, key) => judgements.set(key, value));
  }
  const status = statuses.includes("unavailable") ? "unavailable"
    : statuses.includes("invalid") ? "invalid" : "observed";
  return { provider, status, judgements };
}

export async function judgeProperNameTranslations(sourceItems, translations) {
  if (!enabled() || !translations.length) return null;
  const sources = new Map(sourceItems.map((item) => [item.key, item]));
  const deterministic = new Map();
  const unresolved = [];
  for (const translation of translations) {
    const issues = translationQualityIssues(sources.get(translation.key), translation.translatedName);
    if (!issues.length) {
      unresolved.push(translation);
      continue;
    }
    deterministic.set(translation.key, { decision: "reject", suggestedName: translation.translatedName,
      reasonCode: "quality_rule", qualityIssues: issues, consensus: false,
      votes: [{ model: "deterministic-quality", decision: "reject",
        suggestedName: translation.translatedName, reasonCode: "quality_rule" }] });
  }
  const modelResult = unresolved.length
    ? await judgeModelTranslations(sourceItems.filter((item) => unresolved.some((entry) => entry.key === item.key)), unresolved)
    : null;
  const judgements = new Map();
  for (const translation of translations) judgements.set(translation.key,
    deterministic.get(translation.key) || modelResult?.judgements.get(translation.key) || {
      decision: "invalid", suggestedName: translation.translatedName, reasonCode: "missing_output",
    });
  return { provider: [deterministic.size ? "deterministic-quality" : "", modelResult?.provider || ""]
    .filter(Boolean).join("+"), status: modelResult?.status || "observed", judgements };
}

export function properNameJudgeStatus() {
  return { enabled: enabled(), mode: "advisory-consensus", model: process.env.PROPER_NAME_JUDGE_MODEL?.trim() || "qwen3.5-4b",
    secondaryModel: process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL?.trim() || null,
    consensusMode: process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL?.trim() ? "cascade_unanimous" : "single",
    baseUrl: (process.env.PROPER_NAME_JUDGE_BASE_URL || "http://127.0.0.1:1234/api/v1").replace(/\/$/, ""),
    batchSize: Math.max(1, Math.min(10, Number.parseInt(process.env.PROPER_NAME_JUDGE_BATCH_SIZE || "1", 10) || 1)) };
}
