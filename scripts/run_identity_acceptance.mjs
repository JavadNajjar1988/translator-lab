import process from "node:process";
import pg from "pg";
import { createFeaturesRepository } from "../server/features-repository.mjs";
import { createOsmIdentityResolver } from "../server/osm-identity-enrichment.mjs";
import { translateMapNames } from "../server/translation-provider.mjs";
import { createTranslationWorker } from "../server/translation-worker.mjs";

const connectionString = process.env.DATABASE_URL || "";
const databaseName = (() => { try { return new URL(connectionString).pathname.slice(1); } catch { return ""; } })();
if (!databaseName.includes("_acceptance_")) {
  throw new Error("Acceptance runner refuses a database without _acceptance_ in its name.");
}

const pool = new pg.Pool({ connectionString });
const repository = createFeaturesRepository(pool);
const target = {
  osmType: process.env.ACCEPTANCE_OSM_TYPE || "N",
  osmId: process.env.ACCEPTANCE_OSM_ID || "624452094",
  layer: process.env.ACCEPTANCE_LAYER || "place",
};
try {
  await repository.initialize();
  const before = await pool.query(`
    SELECT properties->>'name' AS source_name, translate->>'name' AS translated_name
    FROM public.geoms WHERE osm_type=$1 AND osm_id=$2::bigint AND layer=$3
  `, [target.osmType, target.osmId, target.layer]);
  await pool.query(`
    UPDATE public.geoms SET translate=jsonb_set(COALESCE(translate, '{}'::jsonb), '{edit}', 'true'::jsonb, true)
    WHERE osm_type=$1 AND osm_id=$2::bigint AND layer=$3
  `, [target.osmType, target.osmId, target.layer]);

  const worker = createTranslationWorker(repository, translateMapNames, {
    enrichIdentity: createOsmIdentityResolver(), batchSize: 1, automaticApply: false,
    provider: { kind: "acceptance", model: "canonical-offline", configured: true },
  });
  const preview = await worker.runOnce({ apply: false, limit: 1 });
  const applied = await worker.runOnce({ apply: true, limit: 1 });
  const after = await pool.query(`
    SELECT properties->>'name' AS source_name, translate->>'name' AS translated_name,
      translate->>'provider' AS provider, translate ? 'edit' AS edit_remaining
    FROM public.geoms WHERE osm_type=$1 AND osm_id=$2::bigint AND layer=$3
  `, [target.osmType, target.osmId, target.layer]);
  const audit = await pool.query(`
    SELECT provider, reason, previous_translation, new_translation
    FROM translation_service.translation_audit
    WHERE osm_type=$1 AND osm_id=$2::bigint AND layer=$3 ORDER BY id DESC LIMIT 1
  `, [target.osmType, target.osmId, target.layer]);
  console.log(JSON.stringify({ database: databaseName, target, before: before.rows[0],
    preview: { status: preview.status, translation: preview.translations?.[0] || null },
    apply: { status: applied.status, persistence: applied.persistence }, after: after.rows[0],
    audit: audit.rows[0] || null }, null, 2));
} finally {
  await pool.end();
}
