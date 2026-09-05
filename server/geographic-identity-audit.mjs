import { canonicalPlaceNames } from "./canonical-place-names.mjs";

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\u200c/g, "")
    .replace(/\s+/g, " ").replace(/[يى]/g, "ی").replace(/ك/g, "ک").toLocaleLowerCase("fa");
}

function compactNormalized(value) {
  return normalized(value).replace(/[\s\-‐‑‒–—]+/g, "");
}

const identityProviders = new Set([
  "canonical-place-memory", "canonical-place-coordinate", "canonical-place-identifier",
]);

export async function auditGeographicIdentities(repository, resolver = canonicalPlaceNames, limit = 10_000) {
  const candidates = await repository.readGeographicIdentityCandidates(limit);
  const items = candidates.map((candidate) => ({ key: candidate.id, sourceName: candidate.sourceName,
    layer: candidate.layer, className: candidate.className, wikidataId: candidate.wikidataId,
    longitude: candidate.longitude, latitude: candidate.latitude }));
  const hits = resolver.resolve(items);
  const methods = { identifier: 0, coordinate: 0, alias: 0 };
  const mismatches = [];
  const orthographicVariants = [];
  const matches = [];
  let resolved = 0;
  let consistent = 0;
  let variantCount = 0;
  let missingTranslation = 0;
  for (const candidate of candidates) {
    const hit = hits.get(candidate.id);
    if (!hit?.canonicalId || !identityProviders.has(hit.provider)) continue;
    resolved += 1;
    if (hit.provider === "canonical-place-identifier") methods.identifier += 1;
    else if (hit.provider === "canonical-place-coordinate") methods.coordinate += 1;
    else methods.alias += 1;
    const same = normalized(candidate.translatedName) === normalized(hit.translatedName);
    const orthographicVariant = !same && candidate.translatedName
      && compactNormalized(candidate.translatedName) === compactNormalized(hit.translatedName);
    if (!candidate.translatedName) missingTranslation += 1;
    else if (same) consistent += 1;
    else if (orthographicVariant) variantCount += 1;
    const row = { id: candidate.id, osmType: candidate.osmType, osmId: candidate.osmId,
      layer: candidate.layer, className: candidate.className, sourceName: candidate.sourceName,
      currentTranslation: candidate.translatedName || null, canonicalTranslation: hit.translatedName,
      canonicalId: hit.canonicalId, resolution: hit.resolution || "alias",
      longitude: candidate.longitude, latitude: candidate.latitude };
    if (orthographicVariant && orthographicVariants.length < 100) orthographicVariants.push(row);
    else if (candidate.translatedName && !same && mismatches.length < 100) mismatches.push(row);
    else if (same && matches.length < 25) matches.push(row);
  }
  const mismatchCount = resolved - consistent - variantCount - missingTranslation;
  return { generatedAt: new Date().toISOString(), readOnly: true, automaticApproval: false,
    summary: { scanned: candidates.length, resolved, unresolved: candidates.length - resolved,
      consistent, orthographicVariants: variantCount, mismatched: mismatchCount, missingTranslation, methods },
    mismatches, orthographicVariants, matches };
}
