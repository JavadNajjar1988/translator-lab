import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { createFeaturesRepository } from "../server/features-repository.mjs";
import { createOsmIdentityResolver, loadOsmIdentitySnapshot } from "../server/osm-identity-enrichment.mjs";
import { mergeIdentitySnapshotHistory } from "../server/osm-identity-snapshot-history.mjs";
import { configureApprovedTranslationMemory } from "../server/translation-memory.mjs";
import { translateMapNames } from "../server/translation-provider.mjs";
import { createTranslationWorker } from "../server/translation-worker.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function databaseName(connectionString) {
  try { return new URL(connectionString).pathname.slice(1); } catch { return ""; }
}

const connectionString = process.env.DATABASE_URL || "";
const database = databaseName(connectionString);
if (!database.includes("_acceptance_")) {
  throw new Error("Workflow acceptance refuses a database without _acceptance_ in its name.");
}

const outputPath = resolve(argument("--output", "work/model-evaluations/workflow-acceptance-5.json"));
const pool = new pg.Pool({ connectionString });
const repository = createFeaturesRepository(pool);
const identifiers = [-910000000001, -910000000002, -910000000003, -910000000004, -910000000005];
const renamedIdentityTarget = { osmType: "W", osmId: "835459958", layer: "water_name_detail",
  sourceName: "Fontaine Roseraie Princesse Grace Renamed" };

async function insertFromTemplate({ id, sourceName, layer, className, properties, translation }) {
  const result = await pool.query(`
    INSERT INTO public.geoms
    SELECT 'N'::character(1), $1::bigint, geom, $2::text, $3::jsonb, $4::jsonb,
      zoom_0, zoom_1, zoom_2, zoom_3, zoom_4, zoom_5, zoom_6, zoom_7,
      zoom_8, zoom_9, zoom_10, zoom_11, zoom_12, zoom_13, zoom_14
    FROM public.geoms
    WHERE ($5::text IS NULL OR BTRIM(properties->>'name') = $5::text)
      AND ($6::text IS NULL OR layer = $6::text)
      AND ($7::text IS NULL OR COALESCE(BTRIM(properties->>'class'), '') = $7::text)
    ORDER BY osm_id
    LIMIT 1
    RETURNING osm_id::text
  `, [id, layer, JSON.stringify(properties), JSON.stringify(translation), sourceName, layer, className]);
  if (result.rowCount !== 1) throw new Error(`Template row not found for acceptance case ${id}.`);
}

try {
  await repository.initialize();
  const identitySnapshot = await loadOsmIdentitySnapshot();
  const currentIdentity = identitySnapshot.entries.find((entry) => entry.osmType === renamedIdentityTarget.osmType
    && entry.osmId === renamedIdentityTarget.osmId);
  if (!currentIdentity?.wikidataId) throw new Error("Renamed identity acceptance target is absent from the snapshot.");
  const acceptanceSnapshot = { ...identitySnapshot,
    entries: mergeIdentitySnapshotHistory(identitySnapshot.entries.map((entry) => entry === currentIdentity
      ? { ...entry, name: renamedIdentityTarget.sourceName } : entry), identitySnapshot) };
  configureApprovedTranslationMemory(acceptanceSnapshot);
  const existing = await pool.query("SELECT COUNT(*)::int AS count FROM public.geoms WHERE osm_id = ANY($1::bigint[])", [identifiers]);
  if (existing.rows[0].count !== 0) throw new Error("Acceptance identifiers already exist; refusing to overwrite them.");

  await insertFromTemplate({ id: identifiers[0], sourceName: "Avenue du Port", layer: "transportation_name",
    className: "minor", properties: { name: "Avenue du Port", class: "minor", acceptance_case: "known_new" }, translation: {} });
  await insertFromTemplate({ id: identifiers[1], sourceName: "Monaco", layer: "place",
    className: "city", properties: { name: "Monaco", class: "city", acceptance_case: "requested_edit" },
    translation: { name: "ترجمه نادرست آزمایشی", edit: true } });
  await insertFromTemplate({ id: identifiers[2], sourceName: null, layer: "poi",
    className: null, properties: { class: "amenity", acceptance_case: "missing_source" }, translation: {} });
  await insertFromTemplate({ id: identifiers[3], sourceName: "Fontvieille", layer: "place",
    className: "suburb", properties: { name: "Fontvieille", class: "suburb", acceptance_case: "proper_memory" }, translation: {} });
  await insertFromTemplate({ id: identifiers[4], sourceName: null, layer: "poi",
    className: null, properties: { name: "Observatoire Cartographique Alpha", class: "museum", acceptance_case: "model_new" },
    translation: {} });
  const renamed = await pool.query(`
    UPDATE public.geoms
    SET properties=jsonb_set(COALESCE(properties, '{}'::jsonb), '{name}', to_jsonb($4::text), true)
        || jsonb_build_object('acceptance_case', 'renamed_identity'),
      translate='{}'::jsonb
    WHERE osm_type=$1::character(1) AND osm_id=$2::bigint AND layer=$3::text
  `, [renamedIdentityTarget.osmType, renamedIdentityTarget.osmId,
    renamedIdentityTarget.layer, renamedIdentityTarget.sourceName]);
  if (renamed.rowCount !== 1) throw new Error("Renamed identity acceptance row was not found.");

  const worker = createTranslationWorker(repository, translateMapNames, {
    enrichIdentity: createOsmIdentityResolver(acceptanceSnapshot), batchSize: 10, automaticApply: false,
    provider: { kind: "local", model: process.env.LOCAL_TRANSLATION_MODEL || "", configured: true },
  });
  const before = await worker.scan(20);
  const run = await worker.runOnce({ apply: true, limit: 10 });
  const after = await worker.scan(20);
  const stored = await pool.query(`
    SELECT osm_id::text, properties->>'acceptance_case' AS acceptance_case,
      COALESCE(properties->>'name', '') AS source_name,
      COALESCE(translate->>'name', '') AS translated_name,
      COALESCE(translate->>'provider', '') AS provider,
      COALESCE((translate->>'edit')::boolean, false) AS edit_remaining
    FROM public.geoms
    WHERE osm_id = ANY($1::bigint[])
      OR (osm_type=$2::character(1) AND osm_id=$3::bigint AND layer=$4::text)
    ORDER BY osm_id
  `, [identifiers, renamedIdentityTarget.osmType, renamedIdentityTarget.osmId, renamedIdentityTarget.layer]);
  const previewBySource = new Map((run.translations || []).map((item) => [item.sourceName, item]));
  const rowByCase = new Map(stored.rows.map((row) => [row.acceptance_case, row]));
  const checks = {
    missingSourceSkipped: !before.candidates.some((item) => item.osmId === String(identifiers[2])),
    knownNewApplied: rowByCase.get("known_new")?.translated_name === "خیابان بندر",
    requestedEditApplied: rowByCase.get("requested_edit")?.translated_name === "موناکو"
      && rowByCase.get("requested_edit")?.edit_remaining === false,
    properMemoryApplied: rowByCase.get("proper_memory")?.translated_name === "فونتوی یو",
    modelWasInvoked: Boolean(previewBySource.get("Observatoire Cartographique Alpha")?.translatedName),
    modelRequiresReview: previewBySource.get("Observatoire Cartographique Alpha")?.reviewRequired === true,
    modelWasNotPersisted: rowByCase.get("model_new")?.translated_name === "",
    modelRemainsQueued: after.candidates.some((item) => item.osmId === String(identifiers[4])),
    renamedIdentityApplied: rowByCase.get("renamed_identity")?.translated_name === "فوارۀ باغ رز پرنسس گریس",
    renamedIdentityUsedApprovedMemory: rowByCase.get("renamed_identity")?.provider === "approved-identity-memory",
  };
  const report = {
    formatVersion: 2, mode: "isolated-six-case-workflow", database,
    automaticApply: false, before: before.summary, run, after: after.summary,
    rows: stored.rows, checks, passed: Object.values(checks).every(Boolean),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n${JSON.stringify({ passed: report.passed, checks, persistence: run.persistence })}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
