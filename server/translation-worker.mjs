export function translationKey(candidate) {
  const wikidataId = String(candidate.wikidataId || candidate.wikidata_id || "").trim().toUpperCase();
  const geographic = ["place", "boundary", "country", "region", "water", "water_name", "natural"]
    .includes(String(candidate.layer || "").trim().toLowerCase());
  const longitude = Number(candidate.longitude);
  const latitude = Number(candidate.latitude);
  const location = wikidataId || (geographic && Number.isFinite(longitude) && Number.isFinite(latitude)
    ? `${longitude.toFixed(4)},${latitude.toFixed(4)}` : "");
  return JSON.stringify([candidate.sourceName, candidate.layer, candidate.className, location]);
}

function queueSummary(candidates) {
  const unique = new Set(candidates.map(translationKey));
  return {
    records: candidates.length,
    uniqueNames: unique.size,
    newNames: candidates.filter((item) => !item.translatedName).length,
    requestedEdits: candidates.filter((item) => item.editRequested).length,
  };
}

const safeAutomaticProviders = new Set([
  "approved-memory", "approved-identity-memory", "controlled-generic-memory", "identifier-preserved",
]);

export function isSafeAutomaticTranslation(translation) {
  const provider = String(translation?.provider || "");
  return translation?.reviewRequired !== true
    && (safeAutomaticProviders.has(provider) || provider.startsWith("canonical-place-"));
}

export function createTranslationWorker(repository, translate, options = {}) {
  const batchSize = Math.max(1, Math.min(Number.parseInt(String(options.batchSize), 10) || 20, 20));
  const intervalMs = Math.max(10_000, Number.parseInt(String(options.intervalMs), 10) || 300_000);
  const automaticApply = options.automaticApply === true;
  const automaticTranslate = typeof options.automaticTranslate === "function" ? options.automaticTranslate : translate;
  const provider = options.provider || { kind: "unknown", model: "", configured: false };
  const enrichIdentity = typeof options.enrichIdentity === "function" ? options.enrichIdentity : (item) => item;
  let running = false;
  let timer = null;
  let lastRun = null;
  let lastAppliedRun = null;
  let lastError = null;

  async function scan(limit = 100) {
    const candidates = (await repository.readTranslationQueue(limit)).map(enrichIdentity);
    return { candidates, summary: queueSummary(candidates) };
  }

  async function runOnce({ apply = false, limit = batchSize, automatic = false } = {}) {
    if (running) return { status: "busy", ...(lastRun ? { lastRun } : {}) };
    running = true;
    lastError = null;
    const startedAt = new Date().toISOString();
    try {
      const { candidates, summary } = await scan(Math.max(limit * 5, limit));
      const unique = new Map();
      for (const candidate of candidates) {
        const key = translationKey(candidate);
        if (!unique.has(key)) unique.set(key, candidate);
        if (unique.size >= limit) break;
      }
      const items = [...unique.entries()].map(([key, item]) => ({ key, sourceName: item.sourceName,
        layer: item.layer, className: item.className, wikidataId: item.wikidataId,
        longitude: item.longitude, latitude: item.latitude }));
      if (!items.length) {
        lastRun = { startedAt, finishedAt: new Date().toISOString(), status: "empty", apply, summary };
        return lastRun;
      }

      const result = await (automatic ? automaticTranslate : translate)(items);
      const byKey = new Map(result.translations.map((translation) => [translation.key, translation]));
      const previews = items.filter((item) => byKey.has(item.key)).map((item) => {
        const translation = byKey.get(item.key);
        return { ...item, translatedName: translation.translatedName,
          strategy: translation.strategy, provider: translation.provider || result.provider,
          nameKind: translation.nameKind, properCore: translation.properCore,
          sourceScript: translation.sourceScript, reviewRequired: translation.reviewRequired === true,
          automaticApproval: translation.automaticApproval, judge: translation.judge };
      });
      const persistence = { updated: 0, conflicts: 0, missing: 0, reviewRequired: 0,
        policySkipped: automatic ? items.length - byKey.size : 0 };
      if (apply) {
        for (const candidate of candidates) {
          const translation = byKey.get(translationKey(candidate));
          if (!translation) continue;
          if (translation.reviewRequired === true) {
            persistence.reviewRequired += 1;
            continue;
          }
          if (automatic && !isSafeAutomaticTranslation(translation)) {
            persistence.policySkipped += 1;
            continue;
          }
          const update = await repository.updateTranslation({ osmType: candidate.osmType, osmId: candidate.osmId,
            layer: candidate.layer, translatedName: translation.translatedName,
            provider: translation.provider || result.provider,
            expectedSourceName: candidate.sourceName, expectedTranslatedName: candidate.translatedName,
            reason: candidate.editRequested ? "edit_requested" : "new_name" });
          if (update.status === "updated") persistence.updated += 1;
          else if (update.status === "conflict") persistence.conflicts += 1;
          else persistence.missing += 1;
        }
      }
      lastRun = { startedAt, finishedAt: new Date().toISOString(), status: apply ? "applied" : "preview",
        apply, summary, translations: previews, persistence };
      if (apply && persistence.updated > 0) lastAppliedRun = lastRun;
      return lastRun;
    } catch (error) {
      lastError = { at: new Date().toISOString(), message: error instanceof Error ? error.message : "translation_failed" };
      throw error;
    } finally { running = false; }
  }

  function status() {
    return { running, automaticApply, automaticPolicy: "trusted-deterministic-only",
      batchSize, intervalMs, provider, lastRun, lastAppliedRun, lastError };
  }

  function start() {
    if (timer || !automaticApply) return false;
    const tick = () => runOnce({ apply: true, automatic: true })
      .catch((error) => console.error("Automatic translation run failed:", error.message));
    void tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { scan, runOnce, status, start, stop };
}
