import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import { createFeaturesRepository } from "./features-repository.mjs";

const { Pool } = pg;
const REQUIRED_COLUMNS = ["osm_type", "osm_id", "geom", "layer", "properties", "translate"];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function clean(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maximumLength);
}

export function normalizeDatabaseConnection(value = {}) {
  const port = Number.parseInt(String(value.port || "5432"), 10);
  const sslMode = ["disable", "require", "verify-full"].includes(value.sslMode) ? value.sslMode : "disable";
  const config = {
    host: clean(value.host, 255),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    database: clean(value.database, 128),
    user: clean(value.user, 128),
    password: typeof value.password === "string" ? value.password : "",
    schema: clean(value.schema || "public", 63),
    table: clean(value.table || "geoms", 63),
    sslMode,
  };
  if (!config.host || !config.port || !config.database || !config.user
    || !IDENTIFIER.test(config.schema) || !IDENTIFIER.test(config.table)) return null;
  return config;
}

export function databaseConnectionFromUrl(connectionString, options = {}) {
  const url = new URL(connectionString);
  return normalizeDatabaseConnection({
    host: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    schema: options.schema || "public",
    table: options.table || "geoms",
    sslMode: options.sslMode || "disable",
  });
}

function publicConfig(config, saved = false) {
  return {
    host: config.host, port: config.port, database: config.database, user: config.user,
    schema: config.schema, table: config.table, sslMode: config.sslMode,
    passwordConfigured: Boolean(config.password), saved,
  };
}

function poolOptions(config) {
  const ssl = config.sslMode === "disable" ? false
    : { rejectUnauthorized: config.sslMode === "verify-full" };
  return {
    host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, ssl, max: 4, connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000, application_name: "translator-lab-feature-api",
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function safeError(error) {
  if (error?.code === "28P01") return { code: "authentication_failed", message: "نام کاربری یا گذرواژه پذیرفته نشد." };
  if (error?.code === "3D000") return { code: "database_not_found", message: "پایگاه داده پیدا نشد." };
  if (["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT"].includes(error?.code)) {
    return { code: "network_unavailable", message: "ارتباط شبکه با سرور پایگاه داده برقرار نشد." };
  }
  return { code: "database_unavailable", message: "آزمایش اتصال به پایگاه داده انجام نشد." };
}

export async function inspectDatabaseConnection(config, options = {}) {
  const pool = options.pool || new Pool(poolOptions(config));
  const ownsPool = !options.pool;
  const startedAt = Date.now();
  try {
    const identity = await pool.query(`
      SELECT current_database() AS database, current_user AS database_user,
        current_setting('server_version') AS server_version,
        (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis_version,
        to_regclass($1)::text AS table_name
    `, [`${config.schema}.${config.table}`]);
    const row = identity.rows[0];
    const tableExists = Boolean(row.table_name);
    let columns = [];
    let privileges = { select: false, updateProperties: false, updateTranslate: false, audit: false };
    let stats = null;
    if (tableExists) {
      const columnResult = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
      `, [config.schema, config.table]);
      columns = columnResult.rows.map((item) => item.column_name);
      const privilegeResult = await pool.query(`
        SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_select,
          has_column_privilege(current_user, $1, 'properties', 'UPDATE') AS can_update_properties,
          has_column_privilege(current_user, $1, 'translate', 'UPDATE') AS can_update_translate,
          (to_regnamespace('translation_service') IS NOT NULL
            OR has_database_privilege(current_user, current_database(), 'CREATE')) AS can_audit
      `, [`${config.schema}.${config.table}`]);
      privileges = {
        select: privilegeResult.rows[0].can_select,
        updateProperties: privilegeResult.rows[0].can_update_properties,
        updateTranslate: privilegeResult.rows[0].can_update_translate,
        audit: privilegeResult.rows[0].can_audit,
      };
      if (privileges.select && REQUIRED_COLUMNS.every((name) => columns.includes(name))) {
        const relation = `${quoteIdentifier(config.schema)}.${quoteIdentifier(config.table)}`;
        const counts = await pool.query(`
          SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL)::integer AS named,
            count(*) FILTER (WHERE NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL
              AND NULLIF(BTRIM(translate->>'name'), '') IS NULL)::integer AS pending,
            count(*) FILTER (WHERE
              LOWER(BTRIM(COALESCE(translate->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(translate->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(translate->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(translate->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(properties->>'edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(properties->>'edited', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(properties->>'needs_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
              OR LOWER(BTRIM(COALESCE(properties->>'translation_edit', ''))) IN ('1', 'true', 'yes', 'edit', 'edited', 'required', 'pending')
            )::integer AS requested_edits
          FROM ${relation}
        `);
        stats = { total: counts.rows[0].total, named: counts.rows[0].named,
          pending: counts.rows[0].pending, requestedEdits: counts.rows[0].requested_edits };
      }
    }
    const missingColumns = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
    const readyForRead = tableExists && Boolean(row.postgis_version) && !missingColumns.length && privileges.select;
    const readyForAutomation = readyForRead && privileges.updateProperties
      && privileges.updateTranslate && privileges.audit;
    return {
      ok: true, latencyMs: Date.now() - startedAt,
      database: row.database, databaseUser: row.database_user, serverVersion: row.server_version,
      postgisVersion: row.postgis_version || null, table: row.table_name || `${config.schema}.${config.table}`,
      tableExists, requiredColumns: REQUIRED_COLUMNS, missingColumns, privileges, stats,
      readyForRead, readyForAutomation,
      checks: [
        { key: "network", label: "ارتباط و ورود", ok: true },
        { key: "postgis", label: "قابلیت مکانی", ok: Boolean(row.postgis_version) },
        { key: "table", label: "جدول داده", ok: tableExists },
        { key: "columns", label: "ساختار ستون‌ها", ok: tableExists && !missingColumns.length },
        { key: "read", label: "دسترسی خواندن", ok: privileges.select },
        { key: "write", label: "دسترسی ثبت ترجمه", ok: privileges.updateProperties && privileges.updateTranslate },
        { key: "audit", label: "تاریخچهٔ تغییرات", ok: privileges.audit },
      ],
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, ...safeError(error) };
  } finally {
    if (ownsPool) await pool.end().catch(() => {});
  }
}

async function readSavedConfig(path) {
  if (!path) return null;
  try { return normalizeDatabaseConnection(JSON.parse(await readFile(path, "utf8"))); }
  catch { return null; }
}

async function writeSavedConfig(path, config) {
  if (!path) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
  return true;
}

function sameIdentity(left, right) {
  return ["host", "port", "database", "user", "schema", "table", "sslMode"]
    .every((key) => String(left?.[key]) === String(right?.[key]));
}

export function createDatabaseConnectionManager(initialConfig, options = {}) {
  const configPath = options.configPath || "";
  let active = null;
  let saved = false;

  const repository = new Proxy({}, {
    get(_target, property) {
      if (!active?.repository || typeof active.repository[property] !== "function") return undefined;
      return active.repository[property].bind(active.repository);
    },
  });

  function withCurrentPassword(input) {
    const normalized = normalizeDatabaseConnection(input);
    if (!normalized) return null;
    if (!normalized.password && active?.config && sameIdentity(normalized, active.config)) {
      normalized.password = active.config.password;
    }
    return normalized;
  }

  async function open(config, shouldPersist) {
    const pool = new Pool(poolOptions(config));
    const inspection = await inspectDatabaseConnection(config, { pool });
    if (!inspection.ok || !inspection.readyForAutomation) {
      await pool.end().catch(() => {});
      return { activated: false, inspection };
    }
    const nextRepository = createFeaturesRepository(pool, { schema: config.schema, table: config.table });
    try { await nextRepository.initialize(); }
    catch {
      await pool.end().catch(() => {});
      return { activated: false, inspection: { ...inspection, readyForAutomation: false,
        ok: false, code: "audit_initialization_failed", message: "جدول تاریخچهٔ تغییرات قابل آماده‌سازی نیست." } };
    }
    let persisted = false;
    if (shouldPersist) {
      try { persisted = await writeSavedConfig(configPath, config); }
      catch {
        await pool.end().catch(() => {});
        return { activated: false, inspection: { ...inspection, ok: false,
          code: "connection_save_failed", message: "تنظیم اتصال در فضای محافظت‌شدهٔ سرویس ذخیره نشد." } };
      }
    }
    const previous = active;
    active = { config, pool, repository: nextRepository, inspection };
    if (shouldPersist) saved = persisted;
    if (previous?.pool) void previous.pool.end().catch(() => {});
    return { activated: true, connection: publicConfig(config, saved), inspection };
  }

  return {
    repository,
    async initialize() {
      const stored = await readSavedConfig(configPath);
      const result = await open(stored || initialConfig, false);
      if (!result.activated && stored) return open(initialConfig, false);
      saved = Boolean(stored && result.activated);
      return result;
    },
    status() {
      return { connected: Boolean(active), connection: active ? publicConfig(active.config, saved) : null,
        inspection: active?.inspection || null };
    },
    async test(input) {
      const config = withCurrentPassword(input);
      if (!config || !config.password) return { ok: false, code: "invalid_connection",
        message: "اطلاعات اتصال یا گذرواژه کامل نیست." };
      return inspectDatabaseConnection(config);
    },
    async activate(input, remember = true) {
      const config = withCurrentPassword(input);
      if (!config || !config.password) return { activated: false,
        inspection: { ok: false, code: "invalid_connection", message: "اطلاعات اتصال یا گذرواژه کامل نیست." } };
      return open(config, remember);
    },
    async close() { if (active?.pool) await active.pool.end(); active = null; },
  };
}
