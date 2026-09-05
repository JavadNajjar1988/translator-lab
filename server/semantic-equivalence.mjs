const instructions = `تو ارزیاب محافظه‌کار هم‌ارزی نام فارسی نقشه هستی. فقط JSON فشرده برگردان.
مرجع تنها صورت نوشتاری ممکن نیست. اگر نامزد همان عارضه، هویت نام خاص، عدد و مفهوم عمومی مرجع را حفظ کرده باشد equivalent است؛ تفاوت ترتیب واژه، فاصله، نیم‌فاصله و شکل رقم به‌تنهایی اختلاف معنایی نیست. اگر مکان، شخص، برند، عدد یا نوع عارضه عوض یا حذف شده باشد different است. اگر با دادهٔ موجود نمی‌توان مطمئن شد uncertain را برگردان.
ساختار خروجی دقیقاً چنین است: {"items":[{"key":"string","decision":"equivalent|different|uncertain","reason_code":"word_order|orthography|same_identity|identity_change|meaning_change|missing_concept|uncertain"}]}`;

function text(payload) {
  return (payload?.output || []).filter((item) => item?.type === "message")
    .map((item) => item.content || "").join("").trim();
}

export function normalizeComparable(value) {
  const digits = "۰۱۲۳۴۵۶۷۸۹";
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  return String(value || "").normalize("NFKC").replaceAll("ي", "ی").replaceAll("ك", "ک")
    .replace(/(?:\u0640|\u064e|\u0650|\u064f|\u064b|\u064d|\u064c|\u0652|\u0651)/gu, "")
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(digits.indexOf(digit)))
    .replace(/[\u200c\s]+/g, " ").replace(/[،,؛;:!؟?()[\]{}«»"'’`´.\-_/\\]+/g, " ")
    .replace(/\s+/g, " ").trim().toLocaleLowerCase("fa");
}

function tokenSignature(value) {
  return normalizeComparable(value).split(" ").filter(Boolean).sort((a, b) => a.localeCompare(b, "fa")).join("|");
}

function deterministic(item) {
  const reference = normalizeComparable(item.reference);
  const candidate = normalizeComparable(item.candidate);
  if (reference && reference === candidate) return { decision: "equivalent", reasonCode: "exact_normalized",
    provider: "deterministic-equivalence" };
  if (reference && candidate && tokenSignature(reference) === tokenSignature(candidate)) return {
    decision: "equivalent", reasonCode: "word_order", provider: "deterministic-equivalence",
  };
  return null;
}

function normalizeDecision(item) {
  const decision = ["equivalent", "different", "uncertain"].includes(item?.decision)
    ? item.decision : "invalid";
  return { decision, reasonCode: typeof item?.reason_code === "string" ? item.reason_code : "invalid_output",
    provider: `semantic-judge:${process.env.SEMANTIC_JUDGE_MODEL?.trim() || "qwen3.5-9b"}` };
}

async function askModel(items) {
  const baseUrl = (process.env.SEMANTIC_JUDGE_BASE_URL || process.env.PROPER_NAME_JUDGE_BASE_URL
    || "http://127.0.0.1:1234/api/v1").replace(/\/$/, "");
  const model = process.env.SEMANTIC_JUDGE_MODEL?.trim() || "qwen3.5-9b";
  const input = JSON.stringify({ items: items.map((item) => ({ key: item.key, source: item.sourceName,
    layer: item.layer || "", class: item.className || "", reference: item.reference,
    candidate: item.candidate })) });
  try {
    const response = await fetch(`${baseUrl}/chat`, { method: "POST",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(Math.max(10_000,
        Number.parseInt(process.env.SEMANTIC_JUDGE_TIMEOUT_MS || "120000", 10) || 120_000)),
      body: JSON.stringify({ model, input, system_prompt: instructions, reasoning: "off", store: false,
        temperature: 0, top_k: 20, max_output_tokens: Math.max(300, items.length * 100) }) });
    if (!response.ok) return new Map(items.map((item) => [item.key, { decision: "invalid",
      reasonCode: "judge_unavailable", provider: `semantic-judge:${model}` }]));
    const raw = text(await response.json());
    if (!raw) throw new Error("empty_output");
    const payload = JSON.parse(raw);
    const expected = new Set(items.map((item) => item.key));
    const results = new Map();
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      if (!expected.has(item?.key) || results.has(item.key)) continue;
      results.set(item.key, normalizeDecision(item));
    }
    for (const item of items) if (!results.has(item.key)) results.set(item.key, { decision: "invalid",
      reasonCode: "missing_output", provider: `semantic-judge:${model}` });
    return results;
  } catch {
    return new Map(items.map((item) => [item.key, { decision: "invalid",
      reasonCode: "invalid_output", provider: `semantic-judge:${model}` }]));
  }
}

export async function evaluateSemanticEquivalence(items) {
  const results = new Map();
  const unresolved = [];
  for (const item of items) {
    const resolved = deterministic(item);
    if (resolved) results.set(item.key, resolved); else unresolved.push(item);
  }
  const batchSize = Math.max(1, Math.min(10,
    Number.parseInt(process.env.SEMANTIC_JUDGE_BATCH_SIZE || "1", 10) || 1));
  for (let offset = 0; offset < unresolved.length; offset += batchSize) {
    const batch = unresolved.slice(offset, offset + batchSize);
    const judged = await askModel(batch);
    judged.forEach((value, key) => results.set(key, value));
  }
  return results;
}
