import assert from "node:assert/strict";
import test from "node:test";
import { inspectDatabaseConnection, normalizeDatabaseConnection } from "../server/database-connection.mjs";

test("database connection input accepts safe identifiers and rejects invalid tables", () => {
  assert.deepEqual(normalizeDatabaseConnection({ host: "db.local", port: "5432", database: "maps",
    user: "translator", password: "secret", schema: "public", table: "geoms", sslMode: "require" }), {
    host: "db.local", port: 5432, database: "maps", user: "translator", password: "secret",
    schema: "public", table: "geoms", sslMode: "require",
  });
  assert.equal(normalizeDatabaseConnection({ host: "db.local", database: "maps", user: "translator",
    schema: "public;drop schema public", table: "geoms" }), null);
});

test("database inspection is read-only and reports automation readiness", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("current_setting")) return { rows: [{ database: "maps", database_user: "translator",
        server_version: "18.0", postgis_version: "3.6", table_name: "public.geoms" }] };
      if (sql.includes("information_schema.columns")) return { rows: ["osm_type", "osm_id", "geom", "layer",
        "properties", "translate"].map((column_name) => ({ column_name })) };
      if (sql.includes("has_table_privilege")) return { rows: [{ can_select: true,
        can_update_properties: true, can_update_translate: true, can_audit: true }] };
      if (sql.includes("count(*)::integer")) return { rows: [{ total: 8975, named: 2377, pending: 0,
        requested_edits: 0 }] };
      assert.fail(`unexpected query: ${sql}`);
    },
  };
  const config = normalizeDatabaseConnection({ host: "db.local", port: 5432, database: "maps",
    user: "translator", password: "secret", schema: "public", table: "geoms" });
  const result = await inspectDatabaseConnection(config, { pool });
  assert.equal(result.readyForRead, true);
  assert.equal(result.readyForAutomation, true);
  assert.deepEqual(result.stats, { total: 8975, named: 2377, pending: 0, requestedEdits: 0 });
  assert.equal(queries.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)), false);
});

test("database inspection returns a safe authentication error", async () => {
  const pool = { query: async () => { throw Object.assign(new Error("password value leaked"), { code: "28P01" }); } };
  const result = await inspectDatabaseConnection(normalizeDatabaseConnection({ host: "db.local", database: "maps",
    user: "translator", password: "secret", schema: "public", table: "geoms" }), { pool });
  assert.deepEqual({ ok: result.ok, code: result.code, message: result.message }, {
    ok: false, code: "authentication_failed", message: "نام کاربری یا گذرواژه پذیرفته نشد.",
  });
  assert.equal(JSON.stringify(result).includes("password value leaked"), false);
});
