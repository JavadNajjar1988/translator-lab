import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { createFeaturesRepository } from "../server/features-repository.mjs";
import { createOsmIdentityResolver } from "../server/osm-identity-enrichment.mjs";
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
  throw new Error("Acceptance pilot refuses a database without _acceptance_ in its name.");
}

const limit = Math.max(1, Math.min(100, Number.parseInt(argument("--limit", "30"), 10) || 30));
const outputPath = resolve(argument("--output", "work/model-evaluations/acceptance-pilot-30.json"));
const pool = new pg.Pool({ connectionString });
const repository = createFeaturesRepository(pool);
let targets = [];

try {
  await repository.initialize();
  const selection = await pool.query(`
    WITH ranked AS (
      SELECT osm_type, osm_id::text, layer, BTRIM(properties->>'name') AS source_name,
        BTRIM(translate->>'name') AS expected_translation,
        COALESCE(BTRIM(properties->>'class'), '') AS class_name,
        row_number() OVER (
          PARTITION BY layer
          ORDER BY md5(osm_type || ':' || osm_id::text || ':' || layer)
        ) AS layer_rank
      FROM public.geoms
      WHERE NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL
        AND NULLIF(BTRIM(translate->>'name'), '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM translation_service.translation_audit audit
          WHERE audit.osm_type=geoms.osm_type AND audit.osm_id=geoms.osm_id AND audit.layer=geoms.layer
        )
        AND NOT (
          LOWER(BTRIM(COALESCE(translate->>'edit', ''))) IN ('1','true','yes','edit','edited','required','pending')
          OR LOWER(BTRIM(COALESCE(properties->>'edit', ''))) IN ('1','true','yes','edit','edited','required','pending')
        )
    ), unique_context AS (
      SELECT DISTINCT ON (source_name, layer, class_name)
        osm_type, osm_id, layer, source_name, expected_translation, class_name, layer_rank
      FROM ranked
      ORDER BY source_name, layer, class_name, layer_rank, osm_type, osm_id
    )
    SELECT osm_type, osm_id, layer, source_name, expected_translation, class_name
    FROM unique_context
    ORDER BY layer_rank, layer, source_name
    LIMIT $1
  `, [limit]);
  targets = selection.rows;
  if (targets.length !== limit) throw new Error(`Only ${targets.length} eligible pilot rows were found.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const target of targets) {
      await client.query(`
        UPDATE public.geoms
        SET translate=jsonb_set(COALESCE(translate, '{}'::jsonb), '{edit}', 'true'::jsonb, true)
        WHERE osm_type=$1::character(1) AND osm_id=$2::bigint AND layer=$3::text
      `, [target.osm_type, target.osm_id, target.layer]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }

  const worker = createTranslationWorker(repository, translateMapNames, {
    enrichIdentity: createOsmIdentityResolver(), batchSize: limit, automaticApply: false,
    provider: { kind: "acceptance", model: process.env.LOCAL_TRANSLATION_MODEL || "offline", configured: true },
  });
  const preview = await worker.runOnce({ apply: false, limit });
  const applied = await worker.runOnce({ apply: true, limit });
  const previewByIdentity = new Map((preview.translations || []).map((item) => [
    JSON.stringify([item.sourceName, item.layer, item.className]), item,
  ]));

  const results = [];
  for (const target of targets) {
    const current = await pool.query(`
      SELECT BTRIM(translate->>'name') AS translated_name, translate->>'provider' AS provider,
        COALESCE((translate->>'edit')::boolean, false) AS edit_remaining
      FROM public.geoms WHERE osm_type=$1::character(1) AND osm_id=$2::bigint AND layer=$3::text
    `, [target.osm_type, target.osm_id, target.layer]);
    const previewItem = previewByIdentity.get(JSON.stringify([
      target.source_name, target.layer, target.class_name,
    ]));
    const row = current.rows[0] || {};
    results.push({
      osmType: target.osm_type, osmId: target.osm_id, layer: target.layer,
      sourceName: target.source_name, expected: target.expected_translation,
      preview: previewItem?.translatedName || null, provider: previewItem?.provider || row.provider || null,
      reviewRequired: previewItem?.reviewRequired === true,
      automaticApproval: previewItem?.automaticApproval || null,
      persisted: row.translated_name || null,
      exact: row.translated_name === target.expected_translation,
      editCleared: row.edit_remaining === false,
    });
  }

  const providers = {};
  for (const row of results) providers[row.provider || "unknown"] = (providers[row.provider || "unknown"] || 0) + 1;
  const summary = {
    requested: limit,
    selected: targets.length,
    previewed: preview.translations?.length || 0,
    updated: applied.persistence.updated,
    conflicts: applied.persistence.conflicts,
    missing: applied.persistence.missing,
    reviewRequired: applied.persistence.reviewRequired,
    exact: results.filter((row) => row.exact).length,
    editCleared: results.filter((row) => row.editCleared).length,
    providers,
  };
  const report = {
    formatVersion: 1, mode: "isolated-acceptance-apply", database,
    startedAt: preview.startedAt, finishedAt: applied.finishedAt,
    automaticWorkerEnabled: false, summary, rows: results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n${JSON.stringify(summary)}\n`);
} finally {
  if (targets.length) {
    const client = await pool.connect().catch(() => null);
    if (client) {
      try {
        for (const target of targets) {
          await client.query(`
            UPDATE public.geoms
            SET properties=COALESCE(properties, '{}'::jsonb) - ARRAY['edit','edited','needs_edit','translation_edit'],
              translate=COALESCE(translate, '{}'::jsonb) - ARRAY['edit','edited','needs_edit','translation_edit']
            WHERE osm_type=$1::character(1) AND osm_id=$2::bigint AND layer=$3::text
          `, [target.osm_type, target.osm_id, target.layer]);
        }
      } finally { client.release(); }
    }
  }
  await pool.end();
}
