import { canonicalPlaceNames } from "./canonical-place-names.mjs";
import defaultSnapshot from "./data/osm-identity-snapshot.mjs";
import { readFile } from "node:fs/promises";

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function normalizedTranslation(value) {
  return normalized(value).replace(/\u200c/g, "").replace(/[يى]/g, "ی").replace(/ك/g, "ک");
}

function compactTranslation(value) {
  return normalizedTranslation(value).replace(/[\s\-‐‑‒–—]+/g, "");
}

function elementKey(osmType, osmId) {
  return `${String(osmType || "").trim().toUpperCase()}:${String(osmId || "").trim()}`;
}

function validWikidataId(value) {
  const match = /^(?:wikidata:)?(Q\d+)$/i.exec(String(value || "").trim());
  return match ? match[1].toUpperCase() : "";
}

function validSnapshot(value) {
  return value && typeof value === "object" && Array.isArray(value.entries)
    && value.entries.every((entry) => entry && ["N", "W", "R"].includes(String(entry.osmType || "").toUpperCase())
      && /^\d+$/.test(String(entry.osmId || "")) && typeof entry.name === "string");
}

export async function loadOsmIdentitySnapshot(path = process.env.OSM_IDENTITY_SNAPSHOT_PATH || "") {
  if (!path) return defaultSnapshot;
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (!validSnapshot(payload)) throw new Error("بستهٔ هویت آفلاین ساختار معتبر ندارد.");
  return Object.freeze({ ...payload, entries: Object.freeze(payload.entries.map((entry) => Object.freeze(entry))) });
}

export function createOsmIdentityResolver(snapshot = defaultSnapshot) {
  const snapshotByElement = new Map(snapshot.entries.map((entry) =>
    [elementKey(entry.osmType, entry.osmId), entry]));
  return (candidate) => {
    if (validWikidataId(candidate.wikidataId)) return candidate;
    const entry = snapshotByElement.get(elementKey(candidate.osmType, candidate.osmId));
    const wikidataId = validWikidataId(entry?.wikidataId);
    if (!entry || !wikidataId || normalized(candidate.sourceName) !== normalized(entry.name)) return candidate;
    return { ...candidate, wikidataId, identitySource: "offline-osm-snapshot",
      identitySnapshotAt: snapshot.fetchedAt };
  };
}

export async function previewOsmIdentityEnrichment(repository, resolver = canonicalPlaceNames,
  snapshot = defaultSnapshot, limit = 10_000, approvedMemory = null) {
  const candidates = await repository.readGeographicIdentityCandidates(limit);
  const snapshotByElement = new Map(snapshot.entries.map((entry) =>
    [elementKey(entry.osmType, entry.osmId), entry]));
  const matched = [];
  let sourceNameChanged = 0;
  let identifiersFound = 0;
  let withoutIdentifier = 0;

  for (const candidate of candidates) {
    const entry = snapshotByElement.get(elementKey(candidate.osmType, candidate.osmId));
    if (!entry) continue;
    const sameSourceName = normalized(candidate.sourceName) === normalized(entry.name);
    if (!sameSourceName) sourceNameChanged += 1;
    const wikidataId = validWikidataId(entry.wikidataId);
    if (wikidataId) identifiersFound += 1;
    else withoutIdentifier += 1;
    matched.push({ candidate, entry, sameSourceName, wikidataId });
  }

  const resolvable = matched.filter((item) => item.sameSourceName && item.wikidataId);
  const identityItems = resolvable.map(({ candidate, wikidataId }) => ({
    key: candidate.id, sourceName: candidate.sourceName, layer: candidate.layer,
    className: candidate.className, wikidataId, longitude: candidate.longitude, latitude: candidate.latitude,
  }));
  const approvedHits = approvedMemory ? await approvedMemory.resolve(identityItems) : new Map();
  const canonicalHits = resolver.resolve(identityItems.filter((item) => !approvedHits.has(item.key)));
  const hits = new Map([...canonicalHits, ...approvedHits]);
  const suggestions = [];
  let canonicalResolved = 0;
  let approvedMemoryResolved = 0;
  let missingCanonicalName = 0;
  let canonicalConsistent = 0;
  let orthographicVariants = 0;
  let translationReview = 0;
  let missingTranslation = 0;
  const decisions = { noAction: 0, safeAutomatic: 0, waitingForTrigger: 0, modelRequired: 0 };
  for (const item of resolvable) {
    const hit = hits.get(item.candidate.id);
    const canonicalIdentifierResolved = hit?.provider === "canonical-place-identifier";
    const approvedIdentityResolved = hit?.provider === "approved-identity-memory";
    const identifierResolved = canonicalIdentifierResolved || approvedIdentityResolved;
    if (canonicalIdentifierResolved) canonicalResolved += 1;
    else if (approvedIdentityResolved) approvedMemoryResolved += 1;
    else missingCanonicalName += 1;
    const sameTranslation = identifierResolved && item.candidate.translatedName
      && normalizedTranslation(item.candidate.translatedName) === normalizedTranslation(hit.translatedName);
    const orthographicVariant = identifierResolved && item.candidate.translatedName && !sameTranslation
      && compactTranslation(item.candidate.translatedName) === compactTranslation(hit.translatedName);
    if (identifierResolved && !item.candidate.translatedName) missingTranslation += 1;
    else if (sameTranslation) canonicalConsistent += 1;
    else if (orthographicVariant) orthographicVariants += 1;
    else if (identifierResolved) translationReview += 1;
    const needsCanonicalChange = identifierResolved && (!item.candidate.translatedName
      || (!sameTranslation && !orthographicVariant) || orthographicVariant);
    const queueEligible = !item.candidate.translatedName || item.candidate.editRequested === true;
    const decision = !identifierResolved ? "offline_model" : !needsCanonicalChange ? "no_action"
      : queueEligible ? "automatic_canonical" : "awaiting_new_or_edit";
    if (decision === "no_action") decisions.noAction += 1;
    else if (decision === "automatic_canonical") decisions.safeAutomatic += 1;
    else if (decision === "awaiting_new_or_edit") decisions.waitingForTrigger += 1;
    else decisions.modelRequired += 1;
    suggestions.push({
      id: item.candidate.id, osmType: item.candidate.osmType, osmId: item.candidate.osmId,
      layer: item.candidate.layer, className: item.candidate.className, sourceName: item.candidate.sourceName,
      currentTranslation: item.candidate.translatedName || null, proposedWikidataId: item.wikidataId,
      canonicalId: identifierResolved ? hit.canonicalId : null,
      canonicalTranslation: identifierResolved ? hit.translatedName : null,
      translationStatus: !identifierResolved ? "dictionary_missing" : !item.candidate.translatedName
        ? "missing_translation" : sameTranslation ? "consistent"
          : orthographicVariant ? "orthographic_variant" : "review",
      decision, queueEligible, editRequested: item.candidate.editRequested === true,
      osmVersion: item.entry.version, osmTimestamp: item.entry.timestamp,
    });
  }

  return {
    generatedAt: new Date().toISOString(), readOnly: true, applyAvailable: false,
    source: { mode: "offline_snapshot", origin: snapshot.source, fetchedAt: snapshot.fetchedAt,
      scope: snapshot.scope, entries: snapshot.entries.length },
    summary: { scanned: candidates.length, snapshotMatches: matched.length,
      absentFromSnapshot: candidates.length - matched.length, identifiersFound, withoutIdentifier,
      sourceNameChanged, resolvedNames: canonicalResolved + approvedMemoryResolved,
      approvedMemoryResolved, canonicalResolved, missingCanonicalName },
    quality: { canonicalConsistent, orthographicVariants, translationReview, missingTranslation },
    decisions,
    suggestions: suggestions.slice(0, 100),
  };
}
