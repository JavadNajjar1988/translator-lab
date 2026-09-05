export type SqlCandidate = {
  key: string;
  sourceName: string;
  layer: string;
  className: string;
  fingerprint: string;
  force: boolean;
};

export type SqlScanStats = {
  total: number;
  noSource: number;
  translated: number;
  pending: number;
  retranslate: number;
  uniqueCandidates: number;
};

export type SqlScanResult = { candidates: SqlCandidate[]; stats: SqlScanStats };

export type SqlTranslationEntry = {
  translatedName: string;
  strategy: "translation" | "transliteration" | "mixed";
  provider: string;
  fingerprint: string;
  translatedAt: string;
};

const copyPrefix = "COPY public.geoms ";
const editKeys = ["edit", "edited", "needs_edit", "translation_edit"];
const truthy = new Set(["1", "true", "yes", "edit", "edited", "required", "pending"]);

function parseCopyJson(raw: string): Record<string, unknown> {
  if (raw === "\\N") return {};
  const value = JSON.parse(raw.replaceAll("\\\\", "\\")) as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function encodeCopyJson(value: Record<string, unknown>) {
  return JSON.stringify(value).replaceAll("\\", "\\\\");
}

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function flagIsTrue(value: unknown) {
  return value === true || value === 1 || (typeof value === "string" && truthy.has(value.trim().toLowerCase()));
}

function hasEditFlag(properties: Record<string, unknown>, translation: Record<string, unknown>) {
  return [translation, properties].some((container) => editKeys.some((key) => flagIsTrue(container[key])));
}

function makeKey(sourceName: string, layer: string, className: string) {
  return JSON.stringify([sourceName, layer, className]);
}

function makeFingerprint(sourceName: string, layer: string, className: string, translatedName: string, force: boolean) {
  return JSON.stringify([sourceName, layer, className, translatedName, force]);
}

function candidateFromFields(fields: string[]): SqlCandidate | null {
  if (fields.length !== 21) return null;
  const properties = parseCopyJson(fields[4]);
  const translation = parseCopyJson(fields[5]);
  const sourceName = cleanName(properties.name);
  const translatedName = cleanName(translation.name);
  const force = hasEditFlag(properties, translation);
  if (!sourceName || (translatedName && !force)) return null;
  const layer = fields[3];
  const className = cleanName(properties.class);
  return {
    key: makeKey(sourceName, layer, className), sourceName, layer, className, force,
    fingerprint: makeFingerprint(sourceName, layer, className, translatedName, force),
  };
}

function linesWithEndings(sql: string) {
  return sql.match(/[^\n]*\n|[^\n]+$/g) || [];
}

export function scanSqlText(sql: string): SqlScanResult {
  const candidates = new Map<string, SqlCandidate>();
  const stats: SqlScanStats = { total: 0, noSource: 0, translated: 0, pending: 0, retranslate: 0, uniqueCandidates: 0 };
  let insideCopy = false;
  for (const line of linesWithEndings(sql)) {
    if (line.startsWith(copyPrefix)) { insideCopy = true; continue; }
    if (!insideCopy) continue;
    const raw = line.replace(/\r?\n$/, "");
    if (raw === "\\.") break;
    const fields = raw.split("\t");
    if (fields.length !== 21) continue;
    stats.total += 1;
    const properties = parseCopyJson(fields[4]);
    const translation = parseCopyJson(fields[5]);
    const sourceName = cleanName(properties.name);
    const translatedName = cleanName(translation.name);
    const force = hasEditFlag(properties, translation);
    if (!sourceName) { stats.noSource += 1; continue; }
    if (translatedName && !force) { stats.translated += 1; continue; }
    if (force) stats.retranslate += 1; else stats.pending += 1;
    const candidate = candidateFromFields(fields);
    if (!candidate) continue;
    const previous = candidates.get(candidate.key);
    if (!previous || (candidate.force && !previous.force)) candidates.set(candidate.key, candidate);
  }
  stats.uniqueCandidates = candidates.size;
  return { candidates: [...candidates.values()], stats };
}

export function cacheEntryMatches(candidate: SqlCandidate, entry?: SqlTranslationEntry) {
  if (!entry?.translatedName.trim()) return false;
  return !candidate.force || entry.fingerprint === candidate.fingerprint;
}

export function applyTranslationsToSql(sql: string, cache: Record<string, SqlTranslationEntry>) {
  let insideCopy = false;
  let updated = 0;
  const output = linesWithEndings(sql).map((line) => {
    if (line.startsWith(copyPrefix)) { insideCopy = true; return line; }
    if (!insideCopy) return line;
    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const raw = line.replace(/\r?\n$/, "");
    if (raw === "\\.") { insideCopy = false; return line; }
    const fields = raw.split("\t");
    const candidate = candidateFromFields(fields);
    const entry = candidate ? cache[candidate.key] : undefined;
    if (!candidate || !cacheEntryMatches(candidate, entry)) return line;
    const properties = parseCopyJson(fields[4]);
    const translation = parseCopyJson(fields[5]);
    editKeys.forEach((key) => { delete properties[key]; delete translation[key]; });
    translation.name = entry.translatedName.trim();
    fields[4] = encodeCopyJson(properties);
    fields[5] = encodeCopyJson(translation);
    updated += 1;
    return fields.join("\t") + newline;
  }).join("");
  return { output, updated };
}
