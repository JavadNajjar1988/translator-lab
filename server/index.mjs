import process from "node:process";
import { createDatabaseConnectionManager, databaseConnectionFromUrl } from "./database-connection.mjs";
import { createHttpServer } from "./http-app.mjs";
import { approvedTranslationMemoryStatus, canonicalPlaceNameStatus, compareMapNameTranslations,
  translateKnownMapNames, translateMapNames, translationProviderStatus,
  translationProviderStatuses } from "./translation-provider.mjs";
import { createTranslationWorker } from "./translation-worker.mjs";
import { languageReadinessStatus } from "./language-readiness.mjs";
import { auditGeographicIdentities } from "./geographic-identity-audit.mjs";
import { createOsmIdentityResolver, loadOsmIdentitySnapshot,
  previewOsmIdentityEnrichment } from "./osm-identity-enrichment.mjs";
import { approvedTranslationMemory, configureApprovedTranslationMemory } from "./translation-memory.mjs";

const host = process.env.FEATURE_API_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.FEATURE_API_PORT || "3006", 10);
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required. Add it to .env before starting the local backend.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("FEATURE_API_PORT must be a valid TCP port.");
}

const initialConnection = databaseConnectionFromUrl(connectionString, {
  schema: process.env.DATABASE_SCHEMA || "public", table: process.env.DATABASE_TABLE || "geoms",
  sslMode: process.env.DATABASE_SSL_MODE || "disable",
});
if (!initialConnection) throw new Error("DATABASE_URL is not a valid PostgreSQL connection.");
const connectionManager = createDatabaseConnectionManager(initialConnection, {
  configPath: process.env.DATABASE_CONNECTION_CONFIG_PATH || "",
});
const initialized = await connectionManager.initialize();
if (!initialized.activated) throw new Error("The configured PostgreSQL database is not compatible with Translator Lab.");
const repository = connectionManager.repository;

const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const automaticApply = truthy(process.env.TRANSLATION_AUTO_APPLY);
const workerEnabled = truthy(process.env.TRANSLATION_WORKER_ENABLED);
const identitySnapshot = await loadOsmIdentitySnapshot();
configureApprovedTranslationMemory(identitySnapshot);
const worker = createTranslationWorker(repository, translateMapNames, {
  batchSize: process.env.TRANSLATION_WORKER_BATCH_SIZE,
  intervalMs: process.env.TRANSLATION_WORKER_INTERVAL_MS,
  automaticApply: workerEnabled && automaticApply,
  provider: translationProviderStatus(),
  automaticTranslate: translateKnownMapNames,
  enrichIdentity: createOsmIdentityResolver(identitySnapshot),
});
await approvedTranslationMemoryStatus();
worker.start();

const allowedOrigins = (process.env.FEATURE_API_ALLOWED_ORIGINS || "http://127.0.0.1:3005,http://localhost:3005")
  .split(",").map((value) => value.trim()).filter(Boolean);
const server = createHttpServer(repository, { allowedOrigins, worker,
  compareTranslations: compareMapNameTranslations, providerStatuses: translationProviderStatuses,
  translationMemoryStatus: approvedTranslationMemoryStatus,
  canonicalPlaceNameStatus,
  geographicIdentityAudit: () => auditGeographicIdentities(repository),
  osmIdentityEnrichment: () => previewOsmIdentityEnrichment(repository, undefined, identitySnapshot,
    10_000, approvedTranslationMemory),
  languageReadinessStatus,
  translatePreview: translateMapNames,
  allowOnlineComparison: truthy(process.env.ONLINE_PROVIDER_COMPARISON_ENABLED),
  allowApiApply: truthy(process.env.TRANSLATION_ALLOW_API_APPLY), connectionManager });

server.listen(port, host, () => {
  console.log(`Translator Lab feature API is listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; closing the local feature API.`);
  worker.stop();
  server.close(async () => {
    await connectionManager.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
