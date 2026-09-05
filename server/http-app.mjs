import { createServer } from "node:http";

function jsonResponse(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

async function readJsonBody(request, maximumBytes = 32 * 1024) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

function cleanString(value, maximumLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximumLength ? cleaned : null;
}

function geographicIdentity(body) {
  const rawId = cleanString(body?.wikidataId, 30);
  const wikidataId = rawId && /^(?:wikidata:)?Q\d+$/i.test(rawId) ? rawId : "";
  const longitude = Number(body?.longitude);
  const latitude = Number(body?.latitude);
  const validCoordinates = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
  return { ...(wikidataId ? { wikidataId } : {}),
    ...(validCoordinates ? { longitude, latitude } : {}) };
}

function translationInput(body) {
  const osmType = cleanString(body?.osmType, 1);
  const osmId = typeof body?.osmId === "string" && /^-?\d{1,19}$/.test(body.osmId) ? body.osmId : null;
  const layer = cleanString(body?.layer, 160);
  const translatedName = cleanString(body?.translatedName, 300);
  const provider = cleanString(body?.provider, 160);
  const expectedSourceName = cleanString(body?.expectedSourceName, 300);
  const expectedTranslatedName = typeof body?.expectedTranslatedName === "string"
    && body.expectedTranslatedName.length <= 300 ? body.expectedTranslatedName.trim() : null;
  if (!osmType || !osmId || !layer || !translatedName || !provider || !expectedSourceName
    || expectedTranslatedName === null) return null;
  return { osmType, osmId, layer, translatedName, provider, expectedSourceName, expectedTranslatedName };
}

function runInput(body) {
  const apply = body?.apply === true;
  const limit = Number.isInteger(body?.limit) && body.limit >= 1 && body.limit <= 20 ? body.limit : 5;
  return { apply, limit };
}

function comparisonInput(body) {
  const sourceName = cleanString(body?.sourceName, 300);
  if (!sourceName) return null;
  return { key: "comparison", sourceName, layer: cleanString(body?.layer, 100) || "",
    className: cleanString(body?.className, 100) || "", ...geographicIdentity(body) };
}

function previewItems(body) {
  if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 20) return null;
  const items = body.items.map((item) => ({
    key: cleanString(item?.key, 500), sourceName: cleanString(item?.sourceName, 300),
    layer: cleanString(item?.layer, 100) || "", className: cleanString(item?.className, 100) || "",
    ...geographicIdentity(item),
  }));
  if (items.some((item) => !item.key || !item.sourceName)
    || new Set(items.map((item) => item.key)).size !== items.length) return null;
  return items;
}

function historyFilter(url) {
  const osmType = url.searchParams.get("osmType");
  const osmId = url.searchParams.get("osmId");
  const layer = url.searchParams.get("layer");
  const requested = Number.parseInt(url.searchParams.get("limit") || "20", 10);
  if ((osmType && osmType.length !== 1) || (osmId && !/^-?\d{1,19}$/.test(osmId))
    || (layer && layer.length > 160)) return null;
  return { osmType: osmType || null, osmId: osmId || null, layer: layer || null,
    limit: Number.isInteger(requested) ? Math.max(1, Math.min(requested, 100)) : 20 };
}

export function createRequestHandler(repository, options = {}) {
  const allowedOrigins = new Set(options.allowedOrigins || ["http://127.0.0.1:3005", "http://localhost:3005"]);
  const worker = options.worker;

  return async function handleRequest(request, response) {
    const headers = corsHeaders(request, allowedOrigins);
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const database = await repository.health();
        jsonResponse(response, 200, { status: "ok", database }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/features") {
        jsonResponse(response, 200, await repository.readDataset(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/database-connection") {
        if (!options.connectionManager) {
          jsonResponse(response, 503, { error: "database_connection_manager_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, options.connectionManager.status(), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/database-connections/test") {
        if (!options.connectionManager) {
          jsonResponse(response, 503, { error: "database_connection_manager_unavailable" }, headers);
          return;
        }
        const result = await options.connectionManager.test(await readJsonBody(request));
        jsonResponse(response, result.ok ? 200 : 400, result, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/database-connections/activate") {
        if (!options.connectionManager) {
          jsonResponse(response, 503, { error: "database_connection_manager_unavailable" }, headers);
          return;
        }
        if (worker?.status().running) {
          jsonResponse(response, 409, { error: "translation_worker_busy" }, headers);
          return;
        }
        const body = await readJsonBody(request);
        const result = await options.connectionManager.activate(body, body?.remember !== false);
        jsonResponse(response, result.activated ? 200 : 400, result, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/translation-queue") {
        if (!worker) {
          jsonResponse(response, 503, { error: "translation_worker_unavailable" }, headers);
          return;
        }
        const requested = Number.parseInt(url.searchParams.get("limit") || "100", 10);
        const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 500)) : 100;
        const queue = await worker.scan(limit);
        jsonResponse(response, 200, queue, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/translation-worker") {
        if (!worker) {
          jsonResponse(response, 503, { error: "translation_worker_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, worker.status(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/translation-providers") {
        if (!options.providerStatuses) {
          jsonResponse(response, 503, { error: "translation_providers_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, { providers: await options.providerStatuses() }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/translation-memory") {
        if (!options.translationMemoryStatus) {
          jsonResponse(response, 503, { error: "translation_memory_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, await options.translationMemoryStatus(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canonical-place-names") {
        if (!options.canonicalPlaceNameStatus) {
          jsonResponse(response, 503, { error: "canonical_place_names_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, options.canonicalPlaceNameStatus(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/geographic-identity-audit") {
        if (!options.geographicIdentityAudit) {
          jsonResponse(response, 503, { error: "geographic_identity_audit_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, await options.geographicIdentityAudit(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/osm-identity-enrichment") {
        if (!options.osmIdentityEnrichment) {
          jsonResponse(response, 503, { error: "osm_identity_enrichment_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, await options.osmIdentityEnrichment(), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/language-readiness") {
        if (!options.languageReadinessStatus) {
          jsonResponse(response, 503, { error: "language_readiness_unavailable" }, headers);
          return;
        }
        jsonResponse(response, 200, options.languageReadinessStatus(), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/translation-previews") {
        if (!options.translatePreview) {
          jsonResponse(response, 503, { error: "translation_preview_unavailable" }, headers);
          return;
        }
        const items = previewItems(await readJsonBody(request));
        if (!items) {
          jsonResponse(response, 400, { error: "invalid_translation_preview" }, headers);
          return;
        }
        jsonResponse(response, 200, await options.translatePreview(items), headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/translation-comparisons") {
        if (options.allowOnlineComparison !== true) {
          jsonResponse(response, 403, { error: "online_provider_disabled" }, headers);
          return;
        }
        if (!options.compareTranslations) {
          jsonResponse(response, 503, { error: "translation_comparison_unavailable" }, headers);
          return;
        }
        const input = comparisonInput(await readJsonBody(request));
        if (!input) {
          jsonResponse(response, 400, { error: "invalid_comparison_input" }, headers);
          return;
        }
        jsonResponse(response, 200, await options.compareTranslations([input]), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/translation-history") {
        const filter = historyFilter(url);
        if (!filter) {
          jsonResponse(response, 400, { error: "invalid_history_filter" }, headers);
          return;
        }
        jsonResponse(response, 200, { entries: await repository.readTranslationHistory(filter) }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/translation-jobs/run") {
        if (!worker) {
          jsonResponse(response, 503, { error: "translation_worker_unavailable" }, headers);
          return;
        }
        const input = runInput(await readJsonBody(request));
        if (input.apply && options.allowApiApply !== true) {
          jsonResponse(response, 403, { error: "automatic_apply_disabled" }, headers);
          return;
        }
        const result = await worker.runOnce(input);
        jsonResponse(response, result.status === "busy" ? 409 : 200, result, headers);
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/api/v1/translations") {
        const input = translationInput(await readJsonBody(request));
        if (!input) {
          jsonResponse(response, 400, { error: "invalid_translation" }, headers);
          return;
        }
        const result = await repository.updateTranslation({ ...input, reason: "reviewed" });
        if (result.status === "updated") {
          jsonResponse(response, 200, { feature: result.feature, audit: result.audit }, headers);
          return;
        }
        if (result.status === "not_found") {
          jsonResponse(response, 404, { error: "feature_not_found" }, headers);
          return;
        }
        jsonResponse(response, 409, { error: "translation_conflict", current: result.current }, headers);
        return;
      }
      const rollbackMatch = request.method === "POST"
        ? url.pathname.match(/^\/api\/v1\/translation-history\/(\d+)\/rollback$/) : null;
      if (rollbackMatch) {
        const result = await repository.rollbackTranslation(rollbackMatch[1]);
        if (result.status === "rolled_back") {
          jsonResponse(response, 200, { feature: result.feature, audit: result.audit }, headers);
          return;
        }
        if (["not_found", "feature_not_found"].includes(result.status)) {
          jsonResponse(response, 404, { error: result.status }, headers);
          return;
        }
        jsonResponse(response, 409, { error: result.status, ...(result.current ? { current: result.current } : {}) }, headers);
        return;
      }
      if (!["GET", "POST", "PATCH"].includes(request.method || "")) {
        jsonResponse(response, 405, { error: "method_not_allowed" }, { ...headers, allow: "GET, POST, PATCH, OPTIONS" });
        return;
      }
      jsonResponse(response, 404, { error: "not_found" }, headers);
    } catch (error) {
      if (error?.statusCode === 400 || error?.statusCode === 413) {
        jsonResponse(response, error.statusCode, { error: error.message }, headers);
        return;
      }
      if ([429, 502, 503].includes(error?.status)) {
        jsonResponse(response, error.status, { error: error.message }, headers);
        return;
      }
      console.error("Database-backed feature request failed:", error);
      jsonResponse(response, 503, { error: "database_unavailable" }, headers);
    }
  };
}

export function createHttpServer(repository, options) {
  return createServer(createRequestHandler(repository, options));
}
