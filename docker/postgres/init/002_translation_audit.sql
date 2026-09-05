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
