const FEATURE_QUERY = `
  SELECT
    osm_type,
    osm_id::text AS osm_id,
    layer,
    properties,
    translate,
    ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::json AS geometry
  FROM public.geoms
  WHERE geom IS NOT NULL
  ORDER BY layer, osm_type, osm_id
`;

const UPDATE_TRANSLATION_QUERY = `
  UPDATE public.geoms
  SET
    properties = COALESCE(properties, '{}'::jsonb) - ARRAY['edit', 'edited', 'needs_edit', 'translation_edit'],
    translate = (
      COALESCE(translate, '{}'::jsonb) - ARRAY['edit', 'edited', 'needs_edit', 'translation_edit']
    ) || jsonb_build_object(
      'name', $4::text,
      'provider', $5::text,
      'translated_at', $6::text
    )
  WHERE osm_type = $1::character(1)
    AND osm_id = $2::bigint
    AND layer = $3::text
    AND NULLIF(BTRIM(properties->>'name'), '') = $7::text
    AND COALESCE(NULLIF(BTRIM(translate->>'name'), ''), '') = $8::text
  RETURNING
    osm_type,
    osm_id::text AS osm_id,
    layer,
    properties,
    translate,
    ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::json AS geometry
`;

const TRANSLATION_QUEUE_QUERY = `
  SELECT
    osm_type,
    osm_id::text AS osm_id,
    layer,
    BTRIM(properties->>'name') AS source_name,
    COALESCE(BTRIM(translate->>'name'), '') AS translated_name,
    COALESCE(BTRIM(properties->>'class'), '') AS class_name,
    COALESCE(NULLIF(BTRIM(properties->>'wikidata'), ''), NULLIF(BTRIM(properties->>'wikidata_id'), '')) AS wikidata_id,
    ST_X(ST_Transform(ST_PointOnSurface(geom), 4326)) AS longitude,
    ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326)) AS latitude,
    (
      LOWER(BTRIM(COALESCE(translate->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
    ) AS edit_requested
  FROM public.geoms
  WHERE NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL
    AND (
      NULLIF(BTRIM(translate->>'name'), '') IS NULL
      OR LOWER(BTRIM(COALESCE(translate->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
    )
  ORDER BY layer, source_name, osm_type, osm_id
  LIMIT $1
`;

const GEOGRAPHIC_IDENTITY_AUDIT_QUERY = `
  SELECT
    osm_type,
    osm_id::text AS osm_id,
    layer,
    BTRIM(properties->>'name') AS source_name,
    COALESCE(BTRIM(translate->>'name'), '') AS translated_name,
    COALESCE(BTRIM(properties->>'class'), '') AS class_name,
    COALESCE(NULLIF(BTRIM(properties->>'wikidata'), ''), NULLIF(BTRIM(properties->>'wikidata_id'), '')) AS wikidata_id,
    (
      LOWER(BTRIM(COALESCE(translate->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(translate->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
      OR LOWER(BTRIM(COALESCE(properties->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
    ) AS edit_requested,
    ST_X(ST_Transform(ST_PointOnSurface(geom), 4326)) AS longitude,
    ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326)) AS latitude
  FROM public.geoms
  WHERE geom IS NOT NULL
    AND NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL
  ORDER BY layer, source_name, osm_type, osm_id
  LIMIT $1
`;

const AUDIT_SCHEMA_QUERY = `
  CREATE SCHEMA IF NOT EXISTS translation_service;
  CREATE TABLE IF NOT EXISTS translation_service.translation_audit (
    id bigserial PRIMARY KEY,
    osm_type character(1) NOT NULL,
    osm_id bigint NOT NULL,
    layer text NOT NULL,
    source_name text NOT NULL,
    previous_translation text NOT NULL DEFAULT '',
    new_translation text NOT NULL DEFAULT '',
    provider text NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    rollback_of bigint REFERENCES translation_service.translation_audit(id),
    reverted_at timestamptz,
    revert_audit_id bigint REFERENCES translation_service.translation_audit(id)
  );
  CREATE INDEX IF NOT EXISTS translation_audit_feature_idx
    ON translation_service.translation_audit (osm_type, osm_id, layer, id DESC);
`;

const INSERT_AUDIT_QUERY = `
  INSERT INTO translation_service.translation_audit
    (osm_type, osm_id, layer, source_name, previous_translation, new_translation, provider, reason, rollback_of)
  VALUES ($1::character(1), $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::bigint)
  RETURNING id::text, created_at
`;

const truthyEditValues = new Set(["1", "true", "yes", "edit", "edited", "required", "pending"]);
const editKeys = ["edit", "edited", "needs_edit", "translation_edit"];

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isTruthyEdit(value) {
  return value === true || value === 1
    || (typeof value === "string" && truthyEditValues.has(value.trim().toLowerCase()));
}

function editRequested(properties, translation) {
  return [translation, properties].some((container) =>
    editKeys.some((key) => isTruthyEdit(container?.[key])));
}

function auditRow(row) {
  return {
    id: String(row.id),
    osmType: row.osm_type,
    osmId: String(row.osm_id),
    layer: row.layer,
    sourceName: stringValue(row.source_name),
    previousTranslation: stringValue(row.previous_translation),
    newTranslation: stringValue(row.new_translation),
    provider: stringValue(row.provider),
    reason: stringValue(row.reason),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    rollbackOf: row.rollback_of == null ? null : String(row.rollback_of),
    revertedAt: row.reverted_at ? (row.reverted_at instanceof Date ? row.reverted_at.toISOString() : String(row.reverted_at)) : null,
    revertAuditId: row.revert_audit_id == null ? null : String(row.revert_audit_id),
  };
}

export function rowToFeature(row) {
  const properties = row.properties || {};
  const translation = row.translate || {};
  const sourceName = stringValue(properties.name);
  const translatedName = stringValue(translation.name);
  const needsEdit = editRequested(properties, translation);
  const status = !sourceName ? "no_source" : needsEdit ? "stale" : translatedName ? "translated" : "pending";

  return {
    type: "Feature",
    id: `${row.osm_type}-${row.osm_id}-${row.layer}`,
    geometry: row.geometry,
    properties: {
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      layer: row.layer,
      source_name: sourceName,
      translated_name: translatedName,
      status,
      edit_requested: needsEdit,
      class: stringValue(properties.class),
      subclass: stringValue(properties.subclass),
      ...(stringValue(translation.provider) ? { provider: stringValue(translation.provider) } : {}),
      ...(stringValue(translation.translated_at) ? { translated_at: stringValue(translation.translated_at) } : {}),
    },
  };
}

function buildMetadata(features, relation = "public.geoms") {
  const stats = { total: 0, named: 0, translated: 0, pending: 0, no_source: 0, stale: 0 };
  const layers = {};

  for (const feature of features) {
    const { layer, source_name: sourceName, status } = feature.properties;
    stats.total += 1;
    if (sourceName) stats.named += 1;
    stats[status] += 1;
    layers[layer] = (layers[layer] || 0) + 1;
  }

  return {
    source: `postgresql:${relation}`,
    live: true,
    generated_at: new Date().toISOString(),
    stats,
    layers: Object.fromEntries(Object.entries(layers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function createFeaturesRepository(pool, options = {}) {
  const schema = options.schema || "public";
  const table = options.table || "geoms";
  const relationName = `${schema}.${table}`;
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const featureQuery = FEATURE_QUERY.replaceAll("public.geoms", relation);
  const updateTranslationQuery = UPDATE_TRANSLATION_QUERY.replaceAll("public.geoms", relation);
  const translationQueueQuery = TRANSLATION_QUEUE_QUERY.replaceAll("public.geoms", relation);
  const geographicIdentityAuditQuery = GEOGRAPHIC_IDENTITY_AUDIT_QUERY.replaceAll("public.geoms", relation);

  return {
    async initialize() {
      await pool.query(AUDIT_SCHEMA_QUERY);
    },

    async health() {
      const result = await pool.query("SELECT current_database() AS database, to_regclass($1)::text AS table_name", [relationName]);
      return { database: result.rows[0].database, table: result.rows[0].table_name };
    },

    async readDataset() {
      const result = await pool.query(featureQuery);
      const features = result.rows.map(rowToFeature);
      return { type: "FeatureCollection", meta: buildMetadata(features, relationName), features };
    },

    async readTranslationQueue(limit = 100) {
      const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 100, 500));
      const result = await pool.query(translationQueueQuery, [safeLimit]);
      return result.rows.map((row) => ({
        id: `${row.osm_type}-${row.osm_id}-${row.layer}`,
        osmType: row.osm_type,
        osmId: row.osm_id,
        layer: row.layer,
        sourceName: stringValue(row.source_name),
        translatedName: stringValue(row.translated_name),
        className: stringValue(row.class_name),
        wikidataId: stringValue(row.wikidata_id),
        longitude: Number.isFinite(Number(row.longitude)) ? Number(row.longitude) : null,
        latitude: Number.isFinite(Number(row.latitude)) ? Number(row.latitude) : null,
        editRequested: Boolean(row.edit_requested),
      }));
    },

    async readGeographicIdentityCandidates(limit = 10_000) {
      const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 10_000, 20_000));
      const result = await pool.query(geographicIdentityAuditQuery, [safeLimit]);
      return result.rows.map((row) => ({
        id: `${row.osm_type}-${row.osm_id}-${row.layer}`,
        osmType: row.osm_type,
        osmId: row.osm_id,
        layer: row.layer,
        sourceName: stringValue(row.source_name),
        translatedName: stringValue(row.translated_name),
        className: stringValue(row.class_name),
        wikidataId: stringValue(row.wikidata_id),
        editRequested: Boolean(row.edit_requested),
        longitude: Number.isFinite(Number(row.longitude)) ? Number(row.longitude) : null,
        latitude: Number.isFinite(Number(row.latitude)) ? Number(row.latitude) : null,
      }));
    },

    async updateTranslation(input) {
      const translatedAt = new Date().toISOString();
      const parameters = [input.osmType, input.osmId, input.layer, input.translatedName,
        input.provider, translatedAt, input.expectedSourceName, input.expectedTranslatedName];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(updateTranslationQuery, parameters);
        if (result.rowCount === 1) {
          const audit = await client.query(INSERT_AUDIT_QUERY, [input.osmType, input.osmId, input.layer,
            input.expectedSourceName, input.expectedTranslatedName, input.translatedName, input.provider,
            input.reason || "reviewed", null]);
          await client.query("COMMIT");
          return { status: "updated", feature: rowToFeature(result.rows[0]),
            audit: { id: audit.rows[0].id, createdAt: audit.rows[0].created_at.toISOString() } };
        }

        const current = await client.query(`
          SELECT properties->>'name' AS source_name, COALESCE(translate->>'name', '') AS translated_name
          FROM ${relation}
          WHERE osm_type = $1::character(1) AND osm_id = $2::bigint AND layer = $3::text
        `, parameters.slice(0, 3));
        await client.query("ROLLBACK");
        if (current.rowCount === 0) return { status: "not_found" };
        return { status: "conflict", current: {
          sourceName: stringValue(current.rows[0].source_name),
          translatedName: stringValue(current.rows[0].translated_name),
        } };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },

    async readTranslationHistory(filter = {}) {
      const safeLimit = Math.max(1, Math.min(Number.parseInt(String(filter.limit), 10) || 20, 100));
      const result = await pool.query(`
        SELECT id::text, osm_type, osm_id::text, layer, source_name, previous_translation,
          new_translation, provider, reason, created_at, rollback_of::text, reverted_at, revert_audit_id::text
        FROM translation_service.translation_audit
        WHERE ($1::character(1) IS NULL OR osm_type = $1::character(1))
          AND ($2::bigint IS NULL OR osm_id = $2::bigint)
          AND ($3::text IS NULL OR layer = $3::text)
        ORDER BY id DESC
        LIMIT $4
      `, [filter.osmType || null, filter.osmId || null, filter.layer || null, safeLimit]);
      return result.rows.map(auditRow);
    },

    async rollbackTranslation(auditId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const auditResult = await client.query(`
          SELECT * FROM translation_service.translation_audit WHERE id = $1::bigint FOR UPDATE
        `, [auditId]);
        if (auditResult.rowCount === 0) { await client.query("ROLLBACK"); return { status: "not_found" }; }
        const audit = auditResult.rows[0];
        if (audit.reverted_at) { await client.query("ROLLBACK"); return { status: "already_reverted" }; }

        const currentResult = await client.query(`
          SELECT properties, translate, ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::json AS geometry
          FROM ${relation}
          WHERE osm_type = $1::character(1) AND osm_id = $2::bigint AND layer = $3::text
          FOR UPDATE
        `, [audit.osm_type, audit.osm_id, audit.layer]);
        if (currentResult.rowCount === 0) { await client.query("ROLLBACK"); return { status: "feature_not_found" }; }
        const current = currentResult.rows[0];
        if (stringValue(current.properties?.name) !== stringValue(audit.source_name)
          || stringValue(current.translate?.name) !== stringValue(audit.new_translation)) {
          await client.query("ROLLBACK");
          return { status: "conflict", current: { sourceName: stringValue(current.properties?.name),
            translatedName: stringValue(current.translate?.name) } };
        }

        const translatedAt = new Date().toISOString();
        const provider = `rollback:${audit.id}`;
        const updated = await client.query(`
          UPDATE ${relation}
          SET translate = CASE WHEN $4::text = '' THEN
            (COALESCE(translate, '{}'::jsonb) - ARRAY['name', 'edit', 'edited', 'needs_edit', 'translation_edit'])
              || jsonb_build_object('provider', $5::text, 'translated_at', $6::text)
            ELSE (COALESCE(translate, '{}'::jsonb) - ARRAY['edit', 'edited', 'needs_edit', 'translation_edit'])
              || jsonb_build_object('name', $4::text, 'provider', $5::text, 'translated_at', $6::text)
          END
          WHERE osm_type = $1::character(1) AND osm_id = $2::bigint AND layer = $3::text
          RETURNING osm_type, osm_id::text, layer, properties, translate,
            ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::json AS geometry
        `, [audit.osm_type, audit.osm_id, audit.layer, stringValue(audit.previous_translation), provider, translatedAt]);
        const rollbackAudit = await client.query(INSERT_AUDIT_QUERY, [audit.osm_type, audit.osm_id, audit.layer,
          audit.source_name, audit.new_translation, audit.previous_translation, provider, "rollback", audit.id]);
        await client.query(`
          UPDATE translation_service.translation_audit
          SET reverted_at = now(), revert_audit_id = $2::bigint
          WHERE id = $1::bigint
        `, [audit.id, rollbackAudit.rows[0].id]);
        await client.query("COMMIT");
        return { status: "rolled_back", feature: rowToFeature(updated.rows[0]),
          audit: { id: rollbackAudit.rows[0].id, createdAt: rollbackAudit.rows[0].created_at.toISOString() } };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
  };
}
