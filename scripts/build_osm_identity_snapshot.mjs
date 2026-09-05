import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { mergeIdentitySnapshotHistory } from "../server/osm-identity-snapshot-history.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("شناسهٔ جدول معتبر نیست.");
  return `"${value}"`;
}

const connectionString = process.env.DATABASE_URL || "";
if (!connectionString) throw new Error("نشانی پایگاه داده تنظیم نشده است.");
const schema = process.env.DATABASE_SCHEMA || "public";
const table = process.env.DATABASE_TABLE || "geoms";
const outputPath = resolve(argument("--output", "work/identity/osm-identity-snapshot.json"));
const endpoint = (process.env.OSM_API_BASE_URL || "https://api.openstreetmap.org/api/0.6").replace(/\/$/, "");
const batchSize = Math.max(1, Math.min(200, Number.parseInt(argument("--batch-size", "100"), 10) || 100));
const pool = new pg.Pool({ connectionString });

async function previousSnapshot() {
  try { return JSON.parse(await readFile(outputPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fetchBatch(kind, ids) {
  if (!ids.length) return [];
  const plural = { N: "nodes", W: "ways", R: "relations" }[kind];
  const parameter = plural;
  const response = await fetch(`${endpoint}/${plural}.json?${parameter}=${ids.join(",")}`, {
    headers: { accept: "application/json", "user-agent": "TranslatorLabIdentitySnapshot/0.1" },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404 && ids.length > 1) {
    const middle = Math.ceil(ids.length / 2);
    return [...await fetchBatch(kind, ids.slice(0, middle)), ...await fetchBatch(kind, ids.slice(middle))];
  }
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`osm_api_${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.elements) ? payload.elements : [];
}

try {
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const result = await pool.query(`
    SELECT DISTINCT UPPER(osm_type)::text AS osm_type, osm_id::text AS osm_id
    FROM ${relation}
    WHERE geom IS NOT NULL
      AND osm_id > 0
      AND NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL
      AND layer IN ('place', 'boundary', 'country', 'region', 'water', 'water_name',
        'water_name_detail', 'mountain_peak', 'natural')
    ORDER BY osm_type, osm_id
  `);
  const requested = new Set(result.rows.map((row) => `${row.osm_type}:${row.osm_id}`));
  const elements = [];
  for (const kind of ["N", "W", "R"]) {
    const ids = result.rows.filter((row) => row.osm_type === kind).map((row) => row.osm_id);
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      elements.push(...await fetchBatch(kind, ids.slice(offset, offset + batchSize)));
    }
  }
  const typeMap = { node: "N", way: "W", relation: "R" };
  const fetchedEntries = elements.map((element) => ({ osmType: typeMap[element.type], osmId: String(element.id),
    name: String(element.tags?.name || "").normalize("NFKC").trim(),
    wikidataId: /^Q\d+$/i.test(String(element.tags?.wikidata || "").trim())
      ? String(element.tags.wikidata).trim().toUpperCase() : "",
    version: element.version ?? null, timestamp: element.timestamp || null }))
    .filter((entry) => requested.has(`${entry.osmType}:${entry.osmId}`) && entry.name)
    .sort((a, b) => a.osmType.localeCompare(b.osmType) || Number(a.osmId) - Number(b.osmId));
  const entries = mergeIdentitySnapshotHistory(fetchedEntries, await previousSnapshot());
  const snapshot = { formatVersion: 1, source: `${endpoint}/[nodes|ways|relations].json`,
    fetchedAt: new Date().toISOString(), scope: "named-geographic-features-from-configured-database",
    requested: result.rows.length, found: entries.length,
    withWikidata: entries.filter((entry) => entry.wikidataId).length, entries };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n${JSON.stringify({ requested: snapshot.requested,
    found: snapshot.found, withWikidata: snapshot.withWikidata })}\n`);
} finally {
  await pool.end();
}
