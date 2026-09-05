import { readFile } from "node:fs/promises";
import defaultIdentitySnapshot from "./data/osm-identity-snapshot.mjs";

function clean(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
}

export function translationMemoryKey(item) {
  return JSON.stringify([
    clean(item.sourceName ?? item.source_name),
    clean(item.layer).toLocaleLowerCase("und"),
    clean(item.className ?? item.class).toLocaleLowerCase("und"),
  ]);
}

function validWikidataId(value) {
  const match = /^(?:wikidata:)?(Q\d+)$/i.exec(clean(value));
  return match ? match[1].toUpperCase() : "";
}

function identityMemoryKey(item, wikidataId = validWikidataId(item.wikidataId ?? item.wikidata_id)) {
  return JSON.stringify([wikidataId, clean(item.layer).toLocaleLowerCase("und"),
    clean(item.className ?? item.class).toLocaleLowerCase("und")]);
}

export function createTranslationMemory(path = process.env.APPROVED_TRANSLATION_MEMORY_PATH || "",
  identitySnapshot = defaultIdentitySnapshot) {
  let loadedPath = null;
  let loading = null;
  let entries = new Map();
  let identityEntries = new Map();
  let metadata = { configured: Boolean(path), loaded: false, entries: 0, identityBindings: 0, conflicts: 0 };

  async function load() {
    if (!path) return metadata;
    if (loadedPath === path && metadata.loaded) return metadata;
    if (loading) return loading;
    loading = (async () => {
      const payload = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(payload?.entries)) throw new Error("فایل حافظهٔ ترجمه ساختار معتبر ندارد.");
      const next = new Map();
      const nextIdentities = new Map();
      const conflicts = [];
      let approvedEntries = 0;
      const snapshotIdsByName = new Map();
      for (const snapshotEntry of identitySnapshot?.entries || []) {
        const wikidataId = validWikidataId(snapshotEntry?.wikidataId);
        if (!wikidataId) continue;
        for (const name of [snapshotEntry?.name, ...(snapshotEntry?.previousNames || [])]) {
          const sourceName = clean(name).toLocaleLowerCase("und");
          if (!sourceName) continue;
          if (!snapshotIdsByName.has(sourceName)) snapshotIdsByName.set(sourceName, new Set());
          snapshotIdsByName.get(sourceName).add(wikidataId);
        }
      }
      for (const entry of payload.entries) {
        const sourceName = clean(entry?.source_name);
        const translatedName = clean(entry?.translated_name);
        if (entry?.approval_status !== "client_approved" || !sourceName || !translatedName) continue;
        approvedEntries += 1;
        const key = translationMemoryKey({ sourceName, layer: entry.layer, className: entry.class });
        const existing = next.get(key);
        if (existing && existing.translatedName !== translatedName) conflicts.push(key);
        else next.set(key, { translatedName, strategy: "mixed", provider: "approved-memory" });
        const snapshotIds = snapshotIdsByName.get(sourceName.toLocaleLowerCase("und"));
        const wikidataId = validWikidataId(entry.wikidata_id)
          || (snapshotIds?.size === 1 ? [...snapshotIds][0] : "");
        if (wikidataId) {
          const identityKey = identityMemoryKey(entry, wikidataId);
          const identityMatch = { translatedName, strategy: "mixed", provider: "approved-identity-memory",
            canonicalId: `wikidata:${wikidataId}`, resolution: "approved-identity",
            reviewRequired: false, automaticApproval: "client-approved-identity" };
          const existingIdentity = nextIdentities.get(identityKey);
          if (existingIdentity && existingIdentity.translatedName !== translatedName) conflicts.push(identityKey);
          else nextIdentities.set(identityKey, identityMatch);
        }
      }
      if (conflicts.length) throw new Error(`حافظهٔ ترجمه ${conflicts.length} تعارض دارد و بارگیری نشد.`);
      entries = next;
      identityEntries = nextIdentities;
      loadedPath = path;
      metadata = { configured: true, loaded: true, entries: approvedEntries, lookupKeys: entries.size,
        identityBindings: identityEntries.size,
        aliases: approvedEntries - entries.size, conflicts: 0,
        sourceSha256: clean(payload.source_sha256) || null };
      return metadata;
    })().finally(() => { loading = null; });
    return loading;
  }

  async function resolve(items) {
    await load();
    const hits = new Map();
    for (const item of items) {
      const wikidataId = validWikidataId(item.wikidataId ?? item.wikidata_id);
      const match = wikidataId ? identityEntries.get(identityMemoryKey(item, wikidataId))
        : entries.get(translationMemoryKey(item));
      if (match) hits.set(item.key, { key: item.key, ...match });
    }
    return hits;
  }

  return { load, resolve, status: () => ({ ...metadata }) };
}

export let approvedTranslationMemory = createTranslationMemory();

export function configureApprovedTranslationMemory(identitySnapshot = defaultIdentitySnapshot,
  path = process.env.APPROVED_TRANSLATION_MEMORY_PATH || "") {
  approvedTranslationMemory = createTranslationMemory(path, identitySnapshot);
  return approvedTranslationMemory;
}
