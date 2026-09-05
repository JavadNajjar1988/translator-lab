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
  throw new Error("Identity acceptance refuses a database without _acceptance_ in its name.");
}

const outputPath = resolve(argument("--output", "work/model-evaluations/identity-cycle-acceptance.json"));
const pool = new pg.Pool({ connectionString });
const insertedIds = [-920000000001, -920000000002];
const renamedTarget = { osmType: "W", osmId: "835459958", layer: "water_name_detail",
  sourceName: "Fontaine Roseraie Princesse Grace Renamed",
  expected: "فوارۀ باغ رز پرنسس گریس" };

async function insertFromTemplate(id, sourceName, layer, className, properties, translation) {
  const result = await pool.query(`
    INSERT INTO public.geoms
    SELECT 'N'::character(1), $1::bigint, geom, $2::text, $3::jsonb, $4::jsonb,
      zoom_0, zoom_1, zoom_2, zoom_3, zoom_4, zoom_5, zoom_6, zoom_7,
      zoom_8, zoom_9, zoom_10, zoom_11, zoom_12, zoom_13, zoom_14
    FROM public.geoms
    WHERE BTRIM(properties->>'name')=$5::text AND layer=$2::text
      AND COALESCE(BTRIM(properties->>'class'), '')=$6::text
    ORDER BY osm_id LIMIT 1 RETURNING osm_id::text
  `, [id, layer, JSON.stringify(properties), JSON.stringify(translation), sourceName, className]);
  if (result.rowCount !== 1) throw new Error(`Acceptance template was not found for ${id}.`);
}

try {
  const repository = createFeaturesRepository(pool);
  await repository.initialize();
  const existing = await pool.query("SELECT COUNT(*)::int AS count FROM public.geoms WHERE osm_id=ANY($1::bigint[])",
    [insertedIds]);
  if (existing.rows[0].count) throw new Error("Identity acceptance rows already exist.");

  const identitySnapshot = await loadOsmIdentitySnapshot();
  const currentIdentity = identitySnapshot.entries.find((entry) => entry.osmType === renamedTarget.osmType
    && entry.osmId === renamedTarget.osmId);
  if (!currentIdentity?.wikidataId) throw new Error("Renamed identity target is absent from the snapshot.");
  const refreshedEntries = identitySnapshot.entries.map((entry) => entry === currentIdentity
    ? { ...entry, name: renamedTarget.sourceName } : entry);
  const acceptanceSnapshot = { ...identitySnapshot,
    entries: mergeIdentitySnapshotHistory(refreshedEntries, identitySnapshot) };
  configureApprovedTranslationMemory(acceptanceSnapshot);

  await insertFromTemplate(insertedIds[0], "Avenue du Port", "transportation_name", "minor",
    { name: "Avenue du Port", class: "minor", acceptance_case: "new_name" }, {});
  await insertFromTemplate(insertedIds[1], "Monaco", "place", "city",
    { name: "Monaco", class: "city", acceptance_case: "edit_tag" },
    { name: "ترجمه نادرست آزمایشی", edit: true });
  const renamed = await pool.query(`
    UPDATE public.geoms
    SET properties=jsonb_set(COALESCE(properties, '{}'::jsonb), '{name}', to_jsonb($4::text), true)
        || jsonb_build_object('acceptance_case', 'renamed_identity'), translate='{}'::jsonb
    WHERE osm_type=$1::character(1) AND osm_id=$2::bigint AND layer=$3::text
  `, [renamedTarget.osmType, renamedTarget.osmId, renamedTarget.layer, renamedTarget.sourceName]);
  if (renamed.rowCount !== 1) throw new Error("Renamed identity row was not found.");

  const worker = createTranslationWorker(repository, translateMapNames, {
    enrichIdentity: createOsmIdentityResolver(acceptanceSnapshot), batchSize: 3, automaticApply: false,
    provider: { kind: "acceptance", model: "deterministic", configured: true },
  });
  const before = await worker.scan(20);
  const preview = await worker.runOnce({ apply: false, limit: 3 });
  const applied = await worker.runOnce({ apply: true, limit: 3 });
  const after = await worker.scan(20);
  const stored = await pool.query(`
    SELECT osm_id::text, properties->>'acceptance_case' AS acceptance_case,
      COALESCE(translate->>'name', '') AS translated_name,
      COALESCE(translate->>'provider', '') AS provider,
      COALESCE((translate->>'edit')::boolean, false) AS edit_remaining
    FROM public.geoms
    WHERE osm_id=ANY($1::bigint[])
      OR (osm_type=$2::character(1) AND osm_id=$3::bigint AND layer=$4::text)
    ORDER BY acceptance_case
  `, [insertedIds, renamedTarget.osmType, renamedTarget.osmId, renamedTarget.layer]);
  const rows = new Map(stored.rows.map((row) => [row.acceptance_case, row]));
  const checks = {
    newNameApplied: rows.get("new_name")?.translated_name === "خیابان بندر",
    editTagApplied: rows.get("edit_tag")?.translated_name === "موناکو"
      && rows.get("edit_tag")?.edit_remaining === false,
    renamedIdentityApplied: rows.get("renamed_identity")?.translated_name === renamedTarget.expected,
    renamedIdentityUsedApprovedMemory: rows.get("renamed_identity")?.provider === "approved-identity-memory",
    queueCleared: !after.candidates.some((item) => insertedIds.includes(Number(item.osmId))
      || item.osmId === renamedTarget.osmId),
    noModelProviderUsed: stored.rows.every((row) => !row.provider.startsWith("local:")
      && !row.provider.startsWith("madlad:")),
  };
  const report = { formatVersion: 1, mode: "isolated-identity-cycle", database,
    automaticApply: false, before: before.summary,
    preview: { status: preview.status, translations: preview.translations },
    apply: { status: applied.status, persistence: applied.persistence },
    after: after.summary, rows: stored.rows, checks, passed: Object.values(checks).every(Boolean) };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n${JSON.stringify({ passed: report.passed, checks,
    persistence: applied.persistence })}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
