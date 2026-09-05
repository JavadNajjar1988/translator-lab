"use client";

import { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent,
  useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decideTranslation, summarizeTranslationQueue } from "./translation-policy";
import { applyTranslationsToSql, cacheEntryMatches, scanSqlText, type SqlScanResult,
  type SqlTranslationEntry } from "./sql-workflow";

type Status = "no_source" | "pending" | "translated" | "failed" | "stale";
type FeatureProperties = {
  osm_type: string; osm_id: string; layer: string; source_name: string;
  translated_name: string; status: Status; class: string; subclass: string;
  edit_requested?: boolean; provider?: string; translated_at?: string;
};
type Geometry = { type: string; coordinates?: unknown; geometries?: Geometry[] };
type MapFeature = { type: "Feature"; id: string; geometry: Geometry; properties: FeatureProperties };
type Dataset = {
  type: "FeatureCollection";
  meta: { source: string; live?: boolean; generated_at?: string;
    stats: Record<string, number>; layers: Record<string, number> };
  features: MapFeature[];
};
type SavedTranslation = { translatedName: string; provider: string; translatedAt: string };
type TranslationEntry = { sourceName: string; translatedName: string; provider: string };
type QueueSummary = { records: number; uniqueNames: number; newNames: number; requestedEdits: number };
type WorkerStatus = { running: boolean; automaticApply: boolean; automaticPolicy?: string;
  batchSize: number; intervalMs: number;
  provider: { kind: string; model: string; configured: boolean };
  lastRun: null | { status: string; finishedAt?: string; persistence?: { updated: number } };
  lastAppliedRun: null | { status: string; finishedAt?: string; persistence?: { updated: number } };
  lastError: null | { at: string; message: string } };
type HistoryEntry = { id: string; osmType: string; osmId: string; layer: string; sourceName: string;
  previousTranslation: string; newTranslation: string; provider: string; reason: string; createdAt: string;
  rollbackOf: string | null; revertedAt: string | null; revertAuditId: string | null };
type ComparisonTranslation = { key: string; translatedName: string;
  strategy: "translation" | "transliteration" | "mixed"; provider?: string };
type TranslationMemoryStatus = { configured: boolean; loaded: boolean; entries: number; conflicts: number };
type CanonicalPlaceStatus = { loaded: boolean; entries: number; aliases: number; languages: number;
  ambiguous: number; coordinates?: number; coordinateResolvableAliases?: number;
  wikidataGazetteerEntries?: number; wikidataGazetteerAliases?: number;
  identitySupplementEntries?: number; identitySupplementFetchedAt?: string;
  wikidataGazetteerExcludedAmbiguous?: number; wikidataGazetteerCoordinates?: number; blockedAliases?: number;
  coordinateEvaluation?: { cases: number; runs: Record<string, { correct: number; wrong: number;
    unresolved: number; accuracy: number }>; midpoint: { cases: number; rejected: number; unsafe: number } } };
type GeographicIdentityAudit = { readOnly: boolean; automaticApproval: boolean; summary: { scanned: number;
  resolved: number; unresolved: number; consistent: number; orthographicVariants: number;
  mismatched: number; missingTranslation: number;
  methods: { identifier: number; coordinate: number; alias: number } } };
type OsmIdentityEnrichment = { readOnly: boolean; applyAvailable: boolean; source: { mode: string;
  fetchedAt: string; entries: number }; summary: { scanned: number; snapshotMatches: number;
  absentFromSnapshot: number; identifiersFound: number; withoutIdentifier: number;
  sourceNameChanged: number; resolvedNames: number; approvedMemoryResolved: number;
  canonicalResolved: number; missingCanonicalName: number };
  quality: { canonicalConsistent: number; orthographicVariants: number;
    translationReview: number; missingTranslation: number };
  decisions: { noAction: number; safeAutomatic: number; waitingForTrigger: number; modelRequired: number };
  suggestions: Array<{ id: string; sourceName: string; currentTranslation: string | null;
    proposedWikidataId: string; canonicalTranslation: string | null;
    translationStatus: "dictionary_missing" | "missing_translation" | "consistent" | "orthographic_variant" | "review";
    decision: "offline_model" | "no_action" | "automatic_canonical" | "awaiting_new_or_edit" }> };
type LanguageReadiness = { automaticApproval: boolean; samples: number; passed: number; passRate: number;
  modelEvaluation: { translatorModel: string; judgeModel: string; summary: { samples: number;
    acceptable: number; acceptableRate: number; different: number; uncertain: number;
    invalid?: number; errors?: number } };
  languages: Array<{ language: string; label: string; samples: number; passed: number; failed: number;
    passRate: number; clientSamples: number; minimumClientSamples: number;
    reference: { samples: number; resolved: number; correct: number; wrong: number; unresolved: number;
      coverageRate: number; precision: number };
    model: null | { samples: number; exact: number; equivalent: number; different: number;
      uncertain: number; invalid?: number; errors?: number; acceptableRate: number };
    status: "quality_gap" | "baseline_passed_model_evaluation_required" }> };
type DatabaseConnection = { host: string; port: number; database: string; user: string; schema: string;
  table: string; sslMode: "disable" | "require" | "verify-full"; passwordConfigured: boolean; saved: boolean };
type ConnectionInspection = { ok: boolean; code?: string; message?: string; latencyMs?: number;
  database?: string; databaseUser?: string; serverVersion?: string; postgisVersion?: string | null;
  table?: string; tableExists?: boolean; missingColumns?: string[]; readyForRead?: boolean;
  readyForAutomation?: boolean; privileges?: { select: boolean; updateProperties: boolean;
    updateTranslate: boolean; audit: boolean }; stats?: { total: number; named: number; pending: number;
    requestedEdits: number } | null; checks?: Array<{ key: string; label: string; ok: boolean }> };
type DatabaseConnectionForm = { host: string; port: string; database: string; user: string; password: string;
  schema: string; table: string; sslMode: "disable" | "require" | "verify-full"; remember: boolean };

const emptyConnectionForm: DatabaseConnectionForm = { host: "", port: "5432", database: "", user: "",
  password: "", schema: "public", table: "geoms", sslMode: "disable", remember: true };

const STORAGE_KEY = "translator-lab-translations-v1";
const FULL_CACHE_KEY = "translator-lab-full-file-cache-v1";
const statusLabels: Record<string, string> = {
  all: "همه وضعیت‌ها", pending: "در انتظار ترجمه", translated: "ترجمه‌شده",
  no_source: "بدون نام مبدأ", failed: "ناموفق", stale: "نیازمند بازترجمه",
};
const demoTranslations: Record<string, string> = {
  "Ligne de Marseille-St-Charles à Vintimille (frontière)": "خط مارسی سن‌شارل به ونتیمیلیا (مرز)",
  "Avenue Jacques Abba": "خیابان ژاک آبا",
  "Avenue Hugues Savorani": "خیابان اوگ ساوورانی",
  "Avenue du 3 Septembre": "خیابان سوم سپتامبر",
  "Stade Didier-Deschamps": "ورزشگاه دیدیه دشان",
  "Impasse du Stade": "بن‌بست ورزشگاه",
  "Avenue Marquet": "خیابان مارکه",
  "Rue du Gabian": "خیابان گابیان",
  "Avenue du Port": "خیابان بندر",
  "Port de Cap d'Ail": "بندر کاپ‌دای",
  "Jetée de Cap d'Ail": "اسکلهٔ کاپ‌دای",
};
type ViewBounds = [number, number, number, number];
type MapLabel = { id: string; x: number; y: number; text: string; translated: boolean };

function readSaved(): Record<string, SavedTranslation> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function readFullCache(): Record<string, SqlTranslationEntry> {
  try { return JSON.parse(localStorage.getItem(FULL_CACHE_KEY) || "{}"); } catch { return {}; }
}

function applySaved(dataset: Dataset): Dataset {
  const saved = readSaved();
  return { ...dataset, features: dataset.features.map((feature) => {
    const item = saved[feature.id];
    return item ? { ...feature, properties: { ...feature.properties, translated_name: item.translatedName,
      status: "translated", provider: item.provider, translated_at: item.translatedAt } } : feature;
  }) };
}

function liveFeaturesEndpoint() {
  const configured = import.meta.env.VITE_FEATURES_API_URL?.trim();
  if (configured) return configured;
  const hostname = window.location.hostname || "127.0.0.1";
  return `http://${hostname}:3006/api/v1/features`;
}

function liveServiceEndpoint(path: string) {
  return liveFeaturesEndpoint().replace(/\/api\/v1\/features\/?$/, path);
}

function boundsOf(feature: MapFeature): [[number, number], [number, number]] | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]); return;
    }
    value.forEach(walk);
  };
  walk(feature.geometry.coordinates);
  feature.geometry.geometries?.forEach((geometry) => walk(geometry.coordinates));
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}

function paddedBounds(bounds: [[number, number], [number, number]], ratio = .06): ViewBounds {
  const [[west, south], [east, north]] = bounds;
  const width = Math.max(east - west, .0015);
  const height = Math.max(north - south, .0015);
  return [west - width * ratio, -(north + height * ratio), width * (1 + ratio * 2), height * (1 + ratio * 2)];
}

function datasetBounds(dataset: Dataset): ViewBounds {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  dataset.features.forEach((feature) => {
    const bounds = boundsOf(feature); if (!bounds) return;
    west = Math.min(west, bounds[0][0]); south = Math.min(south, bounds[0][1]);
    east = Math.max(east, bounds[1][0]); north = Math.max(north, bounds[1][1]);
  });
  return paddedBounds([[west, south], [east, north]], .035);
}

function geometryPath(geometry: Geometry): string {
  const point = (value: unknown) => {
    const pair = value as [number, number];
    return `${pair[0]} ${-pair[1]}`;
  };
  const line = (value: unknown, close = false) => {
    const coordinates = value as Array<[number, number]>;
    if (!coordinates.length) return "";
    return `M ${coordinates.map(point).join(" L ")}${close ? " Z" : ""}`;
  };
  const pointShape = (value: unknown) => {
    const [x, y] = value as [number, number];
    const radius = .00009;
    return `M ${x - radius} ${-y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
  };
  const coordinates = geometry.coordinates as unknown[] | undefined;
  if (geometry.type === "Point") return pointShape(coordinates);
  if (geometry.type === "MultiPoint") return (coordinates || []).map(pointShape).join(" ");
  if (geometry.type === "LineString") return line(coordinates);
  if (geometry.type === "MultiLineString") return (coordinates || []).map((item) => line(item)).join(" ");
  if (geometry.type === "Polygon") return (coordinates || []).map((item) => line(item, true)).join(" ");
  if (geometry.type === "MultiPolygon") return (coordinates || []).flatMap((polygon) => (polygon as unknown[]).map((ring) => line(ring, true))).join(" ");
  return (geometry.geometries || []).map(geometryPath).join(" ");
}

function geometryKind(geometry: Geometry) {
  if (geometry.type.includes("Polygon")) return "area";
  if (geometry.type.includes("Point")) return "point";
  return "line";
}

function labelPoint(feature: MapFeature): [number, number] | null {
  const bounds = boundsOf(feature);
  if (!bounds) return null;
  return [(bounds[0][0] + bounds[1][0]) / 2, -(bounds[0][1] + bounds[1][1]) / 2];
}

function labelPriority(feature: MapFeature) {
  const layerRanks: Record<string, number> = {
    place: 0, water_name: 1, water_name_detail: 2, mountain_peak: 3,
    transportation_name: 4, poi: 5, waterway: 6,
  };
  return (layerRanks[feature.properties.layer] ?? 10)
    - (feature.properties.translated_name ? 3 : 0)
    - (geometryKind(feature.geometry) === "point" ? 1 : 0);
}

function buildMapLabels(features: MapFeature[], view: ViewBounds): MapLabel[] {
  const [viewX, viewY, viewWidth, viewHeight] = view;
  const seenNames = new Set<string>();
  const occupied: Array<[number, number, number, number]> = [];
  const labels: MapLabel[] = [];

  const candidates = features.filter((feature) => feature.properties.source_name)
    .sort((a, b) => labelPriority(a) - labelPriority(b));

  for (const feature of candidates) {
    const point = labelPoint(feature);
    if (!point) continue;
    const [x, y] = point;
    if (x < viewX || x > viewX + viewWidth || y < viewY || y > viewY + viewHeight) continue;

    const rawText = feature.properties.translated_name || feature.properties.source_name;
    const dedupeKey = rawText.trim().toLocaleLowerCase("fa");
    if (!dedupeKey || seenNames.has(dedupeKey)) continue;

    const normalizedX = (x - viewX) / viewWidth;
    const normalizedY = (y - viewY) / viewHeight;
    const halfWidth = Math.min(.14, .016 + Math.min(rawText.length, 34) * .0042);
    const halfHeight = .018;
    const box: [number, number, number, number] = [normalizedX - halfWidth, normalizedY - halfHeight,
      normalizedX + halfWidth, normalizedY + halfHeight];
    const overlaps = occupied.some(([left, top, right, bottom]) =>
      box[0] < right && box[2] > left && box[1] < bottom && box[3] > top);
    if (overlaps) continue;

    occupied.push(box); seenNames.add(dedupeKey);
    labels.push({ id: feature.id, x, y, text: rawText.length > 36 ? `${rawText.slice(0, 35)}…` : rawText,
      translated: Boolean(feature.properties.translated_name) });
    if (labels.length >= 90) break;
  }
  return labels;
}

export default function TranslatorLab() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [viewBounds, setViewBounds] = useState<ViewBounds>([7.398, -43.758, .054, .041]);
  const [selected, setSelected] = useState<MapFeature | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [layerFilter, setLayerFilter] = useState("all");
  const [manualTranslation, setManualTranslation] = useState("");
  const [notice, setNotice] = useState("در حال خواندن داده‌های فایل کارفرما…");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isPersisting, setIsPersisting] = useState(false);
  const [stagedFeatureIds, setStagedFeatureIds] = useState<Set<string>>(new Set());
  const [fullFileOpen, setFullFileOpen] = useState(false);
  const [sqlJob, setSqlJob] = useState<{ fileName: string; text: string; scan: SqlScanResult } | null>(null);
  const [jobStatus, setJobStatus] = useState<"idle" | "ready" | "running" | "paused" | "complete" | "error">("idle");
  const [jobProgress, setJobProgress] = useState({ completed: 0, total: 0 });
  const [jobMessage, setJobMessage] = useState("یک فایل پشتیبان انتخاب کنید؛ پویش روی همین دستگاه انجام می‌شود.");
  const [isMapDragging, setIsMapDragging] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [serviceQueue, setServiceQueue] = useState<QueueSummary | null>(null);
  const [serviceStatusError, setServiceStatusError] = useState("");
  const [translationMemory, setTranslationMemory] = useState<TranslationMemoryStatus | null>(null);
  const [canonicalPlaces, setCanonicalPlaces] = useState<CanonicalPlaceStatus | null>(null);
  const [geographicIdentityAudit, setGeographicIdentityAudit] = useState<GeographicIdentityAudit | null>(null);
  const [osmIdentityEnrichment, setOsmIdentityEnrichment] = useState<OsmIdentityEnrichment | null>(null);
  const [languageReadiness, setLanguageReadiness] = useState<LanguageReadiness | null>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollbackId, setRollbackId] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  const [connectionForm, setConnectionForm] = useState<DatabaseConnectionForm>(emptyConnectionForm);
  const [connectionInspection, setConnectionInspection] = useState<ConnectionInspection | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<"" | "loading" | "testing" | "activating">("");
  const stopRequested = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const databaseTranslations = useRef<Map<string, string>>(new Map());
  const fullView = useRef<ViewBounds>([7.398, -43.758, .054, .041]);
  const mapDrag = useRef<{ pointerId: number; startX: number; startY: number; view: ViewBounds; moved: boolean } | null>(null);
  const suppressMapClick = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const readDataset = async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Dataset request failed with ${response.status}`);
      return response.json() as Promise<Dataset>;
    };

    const loadDataset = async () => {
      let payload: Dataset;
      let sourceMessage: string;
      try {
        payload = await readDataset(liveFeaturesEndpoint());
        sourceMessage = "از پایگاه‌دادهٔ زنده خوانده شد";
      } catch {
        if (cancelled) return;
        payload = await readDataset("/data/map-data.json");
        sourceMessage = "از نسخهٔ ثابت پشتیبان خوانده شد؛ سرویس زنده در دسترس نیست";
      }

      if (cancelled) return;
      const saved = readSaved();
      databaseTranslations.current = new Map(payload.features.map((feature) =>
        [feature.id, feature.properties.translated_name || ""]));
      setStagedFeatureIds(new Set(payload.features.filter((feature) => {
        const draft = saved[feature.id];
        return draft && draft.translatedName !== (feature.properties.translated_name || "");
      }).map((feature) => feature.id)));
      const hydrated = applySaved(payload);
      const bounds = datasetBounds(hydrated);
      fullView.current = bounds;
      setDataset(hydrated);
      setViewBounds(bounds);
      setNotice(`${hydrated.meta.stats.total.toLocaleString("fa-IR")} رکورد ${sourceMessage}.`);
    };

    loadDataset().catch(() => {
      if (!cancelled) setNotice("خواندن داده‌های زنده و نسخهٔ پشتیبان ناموفق بود.");
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);

  const refreshServiceStatus = useCallback(async () => {
    try {
      const [workerResponse, queueResponse, memoryResponse, canonicalResponse, identityResponse,
        enrichmentResponse, languageResponse] = await Promise.all([
        fetch(liveServiceEndpoint("/api/v1/translation-worker"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/translation-queue?limit=500"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/translation-memory"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/canonical-place-names"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/geographic-identity-audit"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/osm-identity-enrichment"), { cache: "no-store" }),
        fetch(liveServiceEndpoint("/api/v1/language-readiness"), { cache: "no-store" }),
      ]);
      if (!workerResponse.ok || !queueResponse.ok || !memoryResponse.ok || !canonicalResponse.ok
        || !identityResponse.ok || !enrichmentResponse.ok || !languageResponse.ok) throw new Error("service_unavailable");
      const worker = await workerResponse.json() as WorkerStatus;
      const queue = await queueResponse.json() as { summary: QueueSummary };
      const memory = await memoryResponse.json() as TranslationMemoryStatus;
      const canonical = await canonicalResponse.json() as CanonicalPlaceStatus;
      const identityAudit = await identityResponse.json() as GeographicIdentityAudit;
      const enrichment = await enrichmentResponse.json() as OsmIdentityEnrichment;
      const readiness = await languageResponse.json() as LanguageReadiness;
      setWorkerStatus(worker); setServiceQueue(queue.summary); setTranslationMemory(memory);
      setCanonicalPlaces(canonical); setGeographicIdentityAudit(identityAudit); setOsmIdentityEnrichment(enrichment);
      setLanguageReadiness(readiness); setServiceStatusError("");
    } catch { setServiceStatusError("وضعیت سرویس در دسترس نیست"); }
  }, []);

  const openConnectionManager = async () => {
    setConnectionOpen(true); setConnectionBusy("loading"); setConnectionInspection(null);
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/database-connection"), { cache: "no-store" });
      const body = await response.json() as { connected?: boolean; connection?: DatabaseConnection;
        inspection?: ConnectionInspection; error?: string };
      if (!response.ok || !body.connection) throw new Error(body.error || "connection_status_unavailable");
      setActiveConnection(body.connection); setConnectionInspection(body.inspection || null);
      setConnectionForm({ host: body.connection.host, port: String(body.connection.port),
        database: body.connection.database, user: body.connection.user, password: "",
        schema: body.connection.schema, table: body.connection.table, sslMode: body.connection.sslMode,
        remember: true });
    } catch { setConnectionInspection({ ok: false, message: "وضعیت اتصال فعلی قابل خواندن نیست." }); }
    finally { setConnectionBusy(""); }
  };

  const connectionPayload = () => ({ ...connectionForm, port: Number.parseInt(connectionForm.port, 10) });

  const testDatabaseConnection = async (event: FormEvent) => {
    event.preventDefault(); setConnectionBusy("testing"); setConnectionInspection(null);
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/database-connections/test"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connectionPayload()),
      });
      const body = await response.json() as ConnectionInspection;
      setConnectionInspection(body);
    } catch { setConnectionInspection({ ok: false, message: "ارتباط با سرویس آزمون اتصال برقرار نشد." }); }
    finally { setConnectionBusy(""); }
  };

  const activateDatabaseConnection = async () => {
    if (!connectionInspection?.readyForAutomation) return;
    setConnectionBusy("activating");
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/database-connections/activate"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connectionPayload()),
      });
      const body = await response.json() as { activated?: boolean; connection?: DatabaseConnection;
        inspection?: ConnectionInspection; error?: string };
      if (!response.ok || !body.activated || !body.connection) {
        setConnectionInspection(body.inspection || { ok: false, message: body.error || "فعال‌سازی اتصال انجام نشد." });
        return;
      }
      setActiveConnection(body.connection); setConnectionInspection(body.inspection || connectionInspection);
      setNotice("اتصال تازه فعال شد؛ داده‌های داشبورد دوباره خوانده می‌شوند.");
      window.setTimeout(() => window.location.reload(), 450);
    } catch { setConnectionInspection({ ok: false, message: "فعال‌سازی اتصال انجام نشد." }); }
    finally { setConnectionBusy(""); }
  };

  const loadFeatureHistory = useCallback(async (feature: MapFeature) => {
    setHistoryLoading(true);
    try {
      const parameters = new URLSearchParams({ osmType: feature.properties.osm_type,
        osmId: feature.properties.osm_id, layer: feature.properties.layer, limit: "8" });
      const response = await fetch(liveServiceEndpoint(`/api/v1/translation-history?${parameters}`), { cache: "no-store" });
      const body = await response.json() as { entries?: HistoryEntry[] };
      if (!response.ok || !body.entries) throw new Error("history_unavailable");
      setHistoryEntries(body.entries);
    } catch { setHistoryEntries([]); }
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshServiceStatus(), 0);
    const timer = window.setInterval(() => void refreshServiceStatus(), 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshServiceStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selected && dataset?.meta.live) void loadFeatureHistory(selected);
      else setHistoryEntries([]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dataset?.meta.live, loadFeatureHistory, selected]);

  const stats = useMemo(() => (dataset?.features || []).reduce((acc, feature) => {
    acc.total++; if (feature.properties.source_name) acc.named++;
    if (feature.properties.status === "pending" || feature.properties.status === "stale") acc.pending++;
    if (feature.properties.status === "translated") acc.translated++;
    if (feature.properties.status === "no_source") acc.noSource++; return acc;
  }, { total: 0, named: 0, pending: 0, translated: 0, noSource: 0 }), [dataset]);

  const queueSummary = useMemo(() => summarizeTranslationQueue((dataset?.features || []).map((feature) => ({
    sourceName: feature.properties.source_name,
    translatedName: feature.properties.translated_name,
    editRequested: feature.properties.edit_requested || feature.properties.status === "stale",
  }))), [dataset]);

  const uniqueQueue = useMemo(() => {
    const seen = new Set<string>();
    return (dataset?.features || []).filter((feature) => {
      const decision = decideTranslation({
        sourceName: feature.properties.source_name,
        translatedName: feature.properties.translated_name,
        editRequested: feature.properties.edit_requested || feature.properties.status === "stale",
      });
      const sourceName = feature.properties.source_name;
      if (!sourceName || !["translate_new", "retranslate"].includes(decision) || seen.has(sourceName)) return false;
      seen.add(sourceName);
      return true;
    });
  }, [dataset]);

  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("fa");
    return (dataset?.features || []).filter(({ properties }) => properties.source_name
      && (statusFilter === "all" || properties.status === statusFilter)
      && (layerFilter === "all" || properties.layer === layerFilter)
      && (!term || `${properties.source_name} ${properties.translated_name} ${properties.osm_id}`.toLocaleLowerCase("fa").includes(term)))
      .slice(0, 60);
  }, [dataset, layerFilter, query, statusFilter]);

  const applyTranslationEntries = (entries: TranslationEntry[]) => {
    if (!dataset || !entries.length) return;
    const translatedAt = new Date().toISOString();
    const bySource = new Map(entries.map((entry) => [entry.sourceName, entry]));
    const next = { ...dataset, features: dataset.features.map((feature) => {
      const entry = bySource.get(feature.properties.source_name);
      return entry ? { ...feature, properties: { ...feature.properties, translated_name: entry.translatedName,
        status: "translated" as const, edit_requested: false, provider: entry.provider, translated_at: translatedAt } } : feature;
    }) };
    setDataset(next);
    const saved = readSaved();
    next.features.forEach((feature) => {
      const entry = bySource.get(feature.properties.source_name);
      if (entry) saved[feature.id] = { translatedName: entry.translatedName, provider: entry.provider, translatedAt };
    });
    setStagedFeatureIds((current) => {
      const updated = new Set(current);
      next.features.forEach((feature) => { if (bySource.has(feature.properties.source_name)) updated.add(feature.id); });
      return updated;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    if (selected) setSelected(next.features.find((feature) => feature.id === selected.id) || null);
  };

  const focusFeature = (feature: MapFeature) => {
    setSelected(feature); setManualTranslation(feature.properties.translated_name || "");
    const bounds = boundsOf(feature); if (!bounds) return;
    setViewBounds(paddedBounds(bounds, .8));
  };

  const openMapFeature = (feature: MapFeature) => {
    if (suppressMapClick.current) { suppressMapClick.current = false; return; }
    setSelected(feature); setManualTranslation(feature.properties.translated_name || "");
  };

  const zoomMap = (factor: number, anchorX = .5, anchorY = .5) => setViewBounds(([x, y, width, height]) => {
    const minimumWidth = fullView.current[2] / 500;
    const maximumWidth = fullView.current[2] * 4;
    const nextWidth = Math.min(maximumWidth, Math.max(minimumWidth, width * factor));
    const appliedFactor = nextWidth / width;
    const nextHeight = height * appliedFactor;
    return [x + (width - nextWidth) * anchorX, y + (height - nextHeight) * anchorY, nextWidth, nextHeight];
  });

  const resetMap = () => { if (dataset) setViewBounds(fullView.current); };

  const handleMapWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchorX = (event.clientX - rect.left) / rect.width;
    const anchorY = (event.clientY - rect.top) / rect.height;
    zoomMap(event.deltaY < 0 ? .82 : 1.22, anchorX, anchorY);
  };

  const startMapDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    mapDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      view: [...viewBounds] as ViewBounds, moved: false };
    setIsMapDragging(true);
  };

  const moveMap = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = mapDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    setViewBounds([drag.view[0] - dx / rect.width * drag.view[2],
      drag.view[1] - dy / rect.height * drag.view[3], drag.view[2], drag.view[3]]);
  };

  const finishMapDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = mapDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressMapClick.current = drag.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    mapDrag.current = null; setIsMapDragging(false);
  };

  const mapFeatures = useMemo(() => [...(dataset?.features || [])].sort((a, b) => {
    const rank = (feature: MapFeature) => ({ area: 0, line: 1, point: 2 })[geometryKind(feature.geometry)];
    return rank(a) - rank(b);
  }), [dataset]);
  const mapFeatureById = useMemo(() => new Map(mapFeatures.map((feature) => [feature.id, feature])), [mapFeatures]);

  const mapLabels = useMemo(() => buildMapLabels(mapFeatures, viewBounds), [mapFeatures, viewBounds]);
  const mapLabelSize = viewBounds[3] / 48;
  const jobPercent = jobProgress.total ? Math.round(jobProgress.completed / jobProgress.total * 100) : 0;
  const workerLastActivity = workerStatus?.lastAppliedRun || workerStatus?.lastRun;

  const saveManual = (event: FormEvent) => {
    event.preventDefault(); if (!selected || !manualTranslation.trim()) return;
    applyTranslationEntries([{ sourceName: selected.properties.source_name, translatedName: manualTranslation.trim(), provider: "manual" }]);
    setNotice("ترجمه به‌صورت پیش‌نویس در مرورگر ثبت شد؛ برای اعمال زنده آن را جداگانه تأیید کنید.");
  };

  const persistSelectedTranslation = async () => {
    if (!dataset?.meta.live || !selected || !stagedFeatureIds.has(selected.id)) return;
    setIsPersisting(true); setNotice("در حال ثبت ترجمهٔ بازبینی‌شده در پایگاه‌داده…");
    try {
      const endpoint = liveServiceEndpoint("/api/v1/translations");
      const response = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ osmType: selected.properties.osm_type, osmId: selected.properties.osm_id,
          layer: selected.properties.layer, translatedName: selected.properties.translated_name,
          provider: selected.properties.provider || "manual", expectedSourceName: selected.properties.source_name,
          expectedTranslatedName: databaseTranslations.current.get(selected.id) || "" }) });
      const body = await response.json() as { feature?: MapFeature; error?: string;
        current?: { translatedName?: string } };
      if (!response.ok || !body.feature) {
        if (response.status === 409) throw new Error(`ترجمهٔ پایگاه‌داده از زمان خواندن تغییر کرده است${body.current?.translatedName ? `: ${body.current.translatedName}` : ""}. داده‌ها را دوباره بخوانید.`);
        throw new Error(body.error || "ثبت ترجمه در پایگاه‌داده انجام نشد.");
      }
      const persisted = body.feature;
      const next = { ...dataset, features: dataset.features.map((feature) =>
        feature.id === persisted.id ? persisted : feature) };
      setDataset(next); setSelected(persisted); setManualTranslation(persisted.properties.translated_name);
      databaseTranslations.current.set(persisted.id, persisted.properties.translated_name);
      setStagedFeatureIds((current) => { const updated = new Set(current); updated.delete(persisted.id); return updated; });
      const saved = readSaved(); delete saved[persisted.id]; localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setNotice("ترجمهٔ بازبینی‌شده در پایگاه‌داده زنده ثبت شد.");
      await loadFeatureHistory(persisted);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ثبت ترجمه در پایگاه‌داده انجام نشد.");
    } finally { setIsPersisting(false); }
  };

  const rollbackTranslation = async (entry: HistoryEntry) => {
    if (!dataset || !selected || rollbackId) return;
    setRollbackId(entry.id); setNotice("در حال بازگردانی ترجمهٔ انتخاب‌شده…");
    try {
      const response = await fetch(liveServiceEndpoint(`/api/v1/translation-history/${entry.id}/rollback`), { method: "POST" });
      const body = await response.json() as { feature?: MapFeature; error?: string };
      if (!response.ok || !body.feature) throw new Error(response.status === 409
        ? "این ترجمه پس از ثبت دوباره تغییر کرده است و بازگردانی ایمن نیست." : body.error || "بازگردانی انجام نشد.");
      const restored = body.feature;
      const next = { ...dataset, features: dataset.features.map((feature) => feature.id === restored.id ? restored : feature) };
      setDataset(next); setSelected(restored); setManualTranslation(restored.properties.translated_name || "");
      databaseTranslations.current.set(restored.id, restored.properties.translated_name || "");
      setStagedFeatureIds((current) => { const updated = new Set(current); updated.delete(restored.id); return updated; });
      const saved = readSaved(); delete saved[restored.id]; localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setNotice("ترجمه با ثبت یک رویداد جدید به مقدار قبلی بازگردانده شد.");
      await loadFeatureHistory(restored); await refreshServiceStatus();
    } catch (error) { setNotice(error instanceof Error ? error.message : "بازگردانی انجام نشد."); }
    finally { setRollbackId(null); }
  };

  const translateNow = async () => {
    if (!selected) return; setIsTranslating(true); setNotice("در حال ترجمه با مدل آفلاین…");
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/translation-previews"), { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ key: "single",
          sourceName: selected.properties.source_name, layer: selected.properties.layer,
          className: selected.properties.class }] }) });
      const body = await response.json() as { translations?: ComparisonTranslation[]; provider?: string; error?: string };
      const translation = body.translations?.[0];
      if (!response.ok || !translation) throw new Error(body.error || "ترجمه انجام نشد.");
      applyTranslationEntries([{ sourceName: selected.properties.source_name, translatedName: translation.translatedName,
        provider: translation.provider || body.provider || "local" }]);
      setManualTranslation(translation.translatedName); setNotice(translation.provider === "approved-memory"
        ? "ترجمه از حافظهٔ تأییدشده بازیابی و فقط به‌صورت پیش‌نویس ثبت شد."
        : "ترجمهٔ آفلاین دریافت و فقط به‌صورت پیش‌نویس ثبت شد.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "ترجمه انجام نشد."); }
    finally { setIsTranslating(false); }
  };

  const scanQueue = async () => {
    setStatusFilter("all");
    if (!dataset?.meta.live) {
      setNotice(`${queueSummary.translate_new.toLocaleString("fa-IR")} نام جدید و ${queueSummary.retranslate.toLocaleString("fa-IR")} نام نیازمند بازترجمه در نسخهٔ پشتیبان دیده شد.`);
      return;
    }
    setNotice("در حال پویش مستقیم پایگاه‌داده…");
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/translation-queue?limit=500"), { cache: "no-store" });
      const body = await response.json() as { summary?: { records: number; uniqueNames: number;
        newNames: number; requestedEdits: number }; error?: string };
      if (!response.ok || !body.summary) throw new Error(body.error || "پویش پایگاه‌داده انجام نشد.");
      setServiceQueue(body.summary);
      setNotice(`${body.summary.newNames.toLocaleString("fa-IR")} رکورد جدید و ${body.summary.requestedEdits.toLocaleString("fa-IR")} رکورد دارای برچسب ویرایش پیدا شد؛ ${body.summary.uniqueNames.toLocaleString("fa-IR")} نام یکتا آمادهٔ پردازش است.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "پویش پایگاه‌داده انجام نشد."); }
  };

  const runDemoBatch = () => {
    const entries = uniqueQueue.flatMap((feature) => {
      const translatedName = demoTranslations[feature.properties.source_name];
      return translatedName ? [{ sourceName: feature.properties.source_name, translatedName, provider: "demo:reviewed-sample" }] : [];
    }).slice(0, 5);
    if (!entries.length) { setNotice("در صف فعلی نامی برای نمونهٔ آزمایشی آماده نیست."); return; }
    applyTranslationEntries(entries);
    setNotice(`${entries.length.toLocaleString("fa-IR")} نام نمونه ترجمه شد و همهٔ رکوردهای هم‌نام نیز یکسان به‌روزرسانی شدند.`);
  };

  const runOnlineBatch = async () => {
    if (!dataset?.meta.live) { setNotice("برای اجرای پویشگر ترجمه، اتصال زندهٔ پایگاه‌داده لازم است."); return; }
    setIsTranslating(true); setNotice("در حال اجرای یک نوبت آزمایشی روی پنج نام نخست صف…");
    try {
      const response = await fetch(liveServiceEndpoint("/api/v1/translation-jobs/run"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: false, limit: 5 }),
      });
      const body = await response.json() as { status?: string; translations?: Array<{
        sourceName: string; translatedName: string; provider: string }>; error?: string };
      if (!response.ok) throw new Error(body.error || "اجرای پویشگر ترجمه ناموفق بود.");
      const entries = (body.translations || []).map((item) => ({ sourceName: item.sourceName,
        translatedName: item.translatedName, provider: item.provider }));
      if (!entries.length) { setNotice("صف پایگاه‌داده خالی است؛ نام جدید یا برچسب ویرایش پیدا نشد."); return; }
      applyTranslationEntries(entries);
      setNotice(`${entries.length.toLocaleString("fa-IR")} ترجمه به‌صورت پیش‌نویس دریافت شد؛ ثبت خودکار در پایگاه‌داده انجام نشد.`);
      await refreshServiceStatus();
    } catch (error) { setNotice(error instanceof Error ? error.message : "اجرای پویشگر ترجمه ناموفق بود."); }
    finally { setIsTranslating(false); }
  };

  const exportSqlPatch = () => {
    if (!dataset) return;
    const saved = readSaved();
    const features = dataset.features.filter((feature) => saved[feature.id] && feature.properties.translated_name);
    if (!features.length) { setNotice("هنوز ترجمه‌ای برای ساخت خروجی ثبت نشده است."); return; }
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const statements = features.map((feature) => `UPDATE public.geoms\nSET translate = (COALESCE(translate, '{}'::jsonb) - 'edit') || jsonb_build_object('name', ${literal(feature.properties.translated_name)})\nWHERE osm_type = ${literal(feature.properties.osm_type)} AND osm_id = ${literal(feature.properties.osm_id)} AND layer = ${literal(feature.properties.layer)}\n  AND NULLIF(BTRIM(properties->>'name'), '') IS NOT NULL;`);
    const sql = [`-- خروجی آزمایشی مترجم نقشه`, `-- فایل اصلی دست‌نخورده باقی مانده است.`, "BEGIN;", ...statements, "COMMIT;", ""].join("\n\n");
    const url = URL.createObjectURL(new Blob([sql], { type: "application/sql;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `translations_patch_${new Date().toISOString().slice(0, 10)}.sql`; anchor.click();
    URL.revokeObjectURL(url); setNotice(`${features.length.toLocaleString("fa-IR")} رکورد در یک فایل خروجی مستقل آماده شد.`);
  };

  const chooseSqlFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".sql")) {
      setJobStatus("error"); setJobMessage("فایل انتخاب‌شده باید پسوند SQL داشته باشد."); return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setJobStatus("error"); setJobMessage("حجم فایل برای پردازش مرورگری بیش از حد مجاز است."); return;
    }
    setJobMessage("در حال پویش فایل…"); setJobStatus("idle");
    try {
      const text = await file.text();
      const scan = scanSqlText(text);
      if (!scan.stats.total) throw new Error("بخش دادهٔ public.geoms در فایل پیدا نشد.");
      const cache = readFullCache();
      const completed = scan.candidates.filter((candidate) => cacheEntryMatches(candidate, cache[candidate.key])).length;
      setSqlJob({ fileName: file.name, text, scan });
      setJobProgress({ completed, total: scan.candidates.length });
      setJobStatus(completed === scan.candidates.length ? "complete" : "ready");
      setJobMessage(`${scan.stats.total.toLocaleString("fa-IR")} ردیف بررسی شد و ${scan.stats.uniqueCandidates.toLocaleString("fa-IR")} نام یکتا در صف قرار گرفت.`);
    } catch (error) {
      setSqlJob(null); setJobStatus("error");
      setJobMessage(error instanceof Error ? error.message : "خواندن فایل ناموفق بود.");
    } finally { event.target.value = ""; }
  };

  const runFullTranslation = async () => {
    if (!sqlJob || jobStatus === "running") return;
    stopRequested.current = false; setJobStatus("running");
    const cache = readFullCache();
    const unresolved = sqlJob.scan.candidates.filter((candidate) => !cacheEntryMatches(candidate, cache[candidate.key]));
    let completed = sqlJob.scan.candidates.length - unresolved.length;
    setJobProgress({ completed, total: sqlJob.scan.candidates.length });
    try {
      for (let offset = 0; offset < unresolved.length; offset += 20) {
        if (stopRequested.current) { setJobStatus("paused"); setJobMessage("پردازش متوقف شد؛ ادامه از همین نقطه امکان‌پذیر است."); return; }
        const batch = unresolved.slice(offset, offset + 20);
        setJobMessage(`در حال ترجمهٔ دستهٔ ${(Math.floor(offset / 20) + 1).toLocaleString("fa-IR")}…`);
        const controller = new AbortController(); activeRequest.current = controller;
        const response = await fetch(liveServiceEndpoint("/api/v1/translation-previews"), { method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: batch.map((item) => ({ key: item.key, sourceName: item.sourceName,
            layer: item.layer, className: item.className })) }) });
        const body = await response.json() as { translations?: Array<{ key: string; translatedName: string;
          strategy: "translation" | "transliteration" | "mixed"; provider?: string }>; provider?: string; error?: string };
        if (!response.ok || !body.translations?.length) throw new Error(body.error || "ترجمهٔ گروهی انجام نشد.");
        const translatedAt = new Date().toISOString();
        body.translations.forEach((result) => {
          const candidate = batch.find((item) => item.key === result.key);
          if (!candidate) return;
          cache[result.key] = { translatedName: result.translatedName, strategy: result.strategy,
            provider: result.provider || body.provider || "local", fingerprint: candidate.fingerprint, translatedAt };
        });
        localStorage.setItem(FULL_CACHE_KEY, JSON.stringify(cache));
        completed += body.translations.length;
        setJobProgress({ completed, total: sqlJob.scan.candidates.length });
      }
      setJobStatus("complete");
      setJobMessage("همهٔ نام‌های صف ترجمه شدند و فایل نهایی آمادهٔ دریافت است.");
    } catch (error) {
      if (stopRequested.current || (error instanceof DOMException && error.name === "AbortError")) {
        setJobStatus("paused"); setJobMessage("پردازش متوقف شد؛ ترجمه‌های انجام‌شده حفظ شده‌اند.");
      } else {
        setJobStatus("error"); setJobMessage(error instanceof Error ? error.message : "پردازش فایل ناموفق بود.");
      }
    } finally { activeRequest.current = null; }
  };

  const pauseFullTranslation = () => {
    stopRequested.current = true; activeRequest.current?.abort();
  };

  const downloadFullSql = () => {
    if (!sqlJob) return;
    const cache = readFullCache();
    const { output, updated } = applyTranslationsToSql(sqlJob.text, cache);
    const url = URL.createObjectURL(new Blob([output], { type: "application/sql;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = sqlJob.fileName.replace(/\.sql$/i, "_translated.sql"); anchor.click();
    URL.revokeObjectURL(url);
    setJobMessage(`${updated.toLocaleString("fa-IR")} ردیف در نسخهٔ کامل جدید به‌روزرسانی شد.`);
  };

  const showFullTranslationsOnMap = () => {
    if (!dataset || !sqlJob || jobStatus !== "complete") return;
    const cache = readFullCache();
    const validEntries = new Map(sqlJob.scan.candidates.flatMap((candidate) => {
      const entry = cache[candidate.key];
      return cacheEntryMatches(candidate, entry) ? [[candidate.key, entry] as const] : [];
    }));
    const saved = readSaved();
    let shown = 0;
    const next: Dataset = { ...dataset, features: dataset.features.map((feature) => {
      const key = JSON.stringify([feature.properties.source_name, feature.properties.layer, feature.properties.class]);
      const entry = validEntries.get(key);
      if (!entry) return feature;
      shown += 1;
      saved[feature.id] = { translatedName: entry.translatedName, provider: entry.provider,
        translatedAt: entry.translatedAt };
      return { ...feature, properties: { ...feature.properties, translated_name: entry.translatedName,
        status: "translated", edit_requested: false, provider: entry.provider, translated_at: entry.translatedAt } };
    }) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    setDataset(next);
    if (selected) setSelected(next.features.find((feature) => feature.id === selected.id) || null);
    setStatusFilter("all");
    setFullFileOpen(false);
    setNotice(`${shown.toLocaleString("fa-IR")} عارضه از نتیجهٔ فایل کامل روی نقشه نمایش داده شد.`);
  };

  return <main className="lab-shell">
    <header className="topbar">
      <div><p className="eyebrow">محیط کنترل محلی</p><h1>آزمایشگاه ترجمهٔ نام‌های نقشه</h1></div>
      <div className="top-actions"><div className="scan-status" aria-live="polite"><span className="status-dot"/><span>{notice}</span></div>
        <button className="connection-open" onClick={() => void openConnectionManager()}>اتصال به پایگاه داده</button>
        <button className="full-file-open" onClick={() => setFullFileOpen(true)}>پردازش فایل کامل</button></div>
    </header>
    <section className="metric-row" aria-label="خلاصه وضعیت داده‌ها">
      <article><span>کل رکوردها</span><strong>{stats.total.toLocaleString("fa-IR")}</strong></article>
      <article><span>دارای نام</span><strong>{stats.named.toLocaleString("fa-IR")}</strong></article>
      <article className="metric-pending"><span>در انتظار</span><strong>{stats.pending.toLocaleString("fa-IR")}</strong></article>
      <article className="metric-success"><span>ترجمه‌شده</span><strong>{stats.translated.toLocaleString("fa-IR")}</strong></article>
      <article><span>بدون نام مبدأ</span><strong>{stats.noSource.toLocaleString("fa-IR")}</strong></article>
    </section>
    <section className={`worker-strip ${workerStatus?.automaticApply ? "is-automatic" : "is-review"}`}
      aria-label="وضعیت سرویس ترجمه" aria-live="polite">
      <div className="worker-heading"><span className={`worker-pulse ${workerStatus?.running ? "is-running" : ""}`}/>
        <span><strong>پویشگر ترجمه</strong><small>{serviceStatusError || (workerStatus?.running ? "در حال پردازش" : "آماده")}</small></span></div>
      <div><span>حالت اجرا</span><strong>{workerStatus?.automaticApply ? "ثبت خودکار محدود" : "بازبینی دستی"}</strong></div>
      <div><span>صف فعلی</span><strong>{serviceQueue ? `${serviceQueue.uniqueNames.toLocaleString("fa-IR")} نام یکتا` : "در حال خواندن"}</strong></div>
      <div><span>مدل فعال</span><strong><bdi>{workerStatus?.provider.model || "تنظیم نشده"}</bdi></strong>
        <small>{workerStatus?.provider.configured ? "آمادهٔ فراخوانی" : "نیازمند تنظیم"}</small></div>
      <div><span>حافظهٔ تأییدشده</span><strong>{translationMemory?.loaded
        ? `${translationMemory.entries.toLocaleString("fa-IR")} ترجمه` : "در حال خواندن"}</strong>
        <small>{canonicalPlaces?.loaded
          ? `${canonicalPlaces.entries.toLocaleString("fa-IR")} نام معیار؛ ${canonicalPlaces.coordinates?.toLocaleString("fa-IR") || "۰"} مکان دارای مختصات؛ آزمون ۲۵ کیلومتری: ${canonicalPlaces.coordinateEvaluation?.runs?.["25"]?.wrong.toLocaleString("fa-IR") ?? "—"} خطا`
          : translationMemory?.loaded && !translationMemory.conflicts ? "بدون تعارض" : "نیازمند بررسی"}</small></div>
      <div><span>{workerStatus?.lastAppliedRun ? "آخرین تغییر" : "آخرین اجرا"}</span><strong>{workerLastActivity?.finishedAt
        ? new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(workerLastActivity.finishedAt))
        : "هنوز اجرا نشده"}</strong>{workerStatus?.lastAppliedRun?.persistence?.updated
          ? <small>{workerStatus.lastAppliedRun.persistence.updated.toLocaleString("fa-IR")} رکورد ثبت شد</small> : null}</div>
      <div><span>ممیزی مکانی دادهٔ واقعی</span><strong>{geographicIdentityAudit
        ? `${geographicIdentityAudit.summary.resolved.toLocaleString("fa-IR")} تطبیق از ${geographicIdentityAudit.summary.scanned.toLocaleString("fa-IR")}`
        : "در حال بررسی"}</strong><small>{geographicIdentityAudit
          ? `${geographicIdentityAudit.summary.mismatched.toLocaleString("fa-IR")} اختلاف؛ ${geographicIdentityAudit.summary.orthographicVariants.toLocaleString("fa-IR")} تفاوت نوشتاری؛ فقط‌خواندنی`
          : "بدون تغییر پایگاه داده"}</small></div>
      <div><span>غنی‌سازی شناسه‌های مکانی</span><strong>{osmIdentityEnrichment
        ? `${osmIdentityEnrichment.summary.identifiersFound.toLocaleString("fa-IR")} شناسه از ${osmIdentityEnrichment.summary.snapshotMatches.toLocaleString("fa-IR")} عارضه`
        : "در حال بررسی"}</strong><small>{osmIdentityEnrichment
          ? `${osmIdentityEnrichment.summary.resolvedNames.toLocaleString("fa-IR")} متصل؛ ${osmIdentityEnrichment.summary.approvedMemoryResolved.toLocaleString("fa-IR")} از حافظهٔ کارفرما؛ ${osmIdentityEnrichment.summary.missingCanonicalName.toLocaleString("fa-IR")} بدون نام فارسی معتبر؛ فقط‌خواندنی`
          : "پیش‌نمایش بستهٔ محلی"}</small></div>
      <button className="worker-refresh" onClick={() => void refreshServiceStatus()}>به‌روزرسانی وضعیت</button>
    </section>
    <section className="identity-decisions" aria-label="تصمیم خودکار نام‌های جغرافیایی">
      <div className="identity-decisions-heading"><span><strong>تصمیم خودکار نام‌های قطعی</strong>
        <small>اجرای سیاست نام جدید و برچسب ویرایش، بدون دور زدن صف ترجمه</small></span>
        <b className="approval-lock">پیش‌نمایش فقط‌خواندنی</b></div>
      <div className="identity-decision-metrics">
        <article className="decision-safe"><span>آمادهٔ اجرای خودکار</span><strong>{osmIdentityEnrichment?.decisions.safeAutomatic.toLocaleString("fa-IR") ?? "—"}</strong></article>
        <article><span>منتظر نام جدید یا برچسب ویرایش</span><strong>{osmIdentityEnrichment?.decisions.waitingForTrigger.toLocaleString("fa-IR") ?? "—"}</strong></article>
        <article><span>بدون نیاز به تغییر</span><strong>{osmIdentityEnrichment?.decisions.noAction.toLocaleString("fa-IR") ?? "—"}</strong></article>
        <article className="decision-model"><span>نیازمند مدل یا منبع تکمیلی</span><strong>{osmIdentityEnrichment?.decisions.modelRequired.toLocaleString("fa-IR") ?? "—"}</strong></article>
      </div>
      <div className="identity-suggestions">{osmIdentityEnrichment?.suggestions
        .filter((item) => item.decision !== "no_action").map((item) =>
          <article key={item.id} className={`identity-suggestion decision-${item.decision}`}>
            <div><strong>{item.sourceName}</strong><bdi>{item.proposedWikidataId}</bdi></div>
            <p><span>{item.currentTranslation || "بدون ترجمه"}</span><i aria-hidden="true">←</i>
              <strong>{item.canonicalTranslation || "نام فارسی معیار موجود نیست"}</strong></p>
            <small>{item.decision === "awaiting_new_or_edit" ? "اصلاح قطعی است؛ طبق قرارداد فقط با نام جدید یا برچسب ویرایش اجرا می‌شود"
              : item.decision === "automatic_canonical" ? "در اجرای بعدی صف، خودکار از فرهنگ‌نامه اعمال می‌شود"
                : "ابتدا مدل آفلاین و داور بررسی می‌کنند؛ ثبت خودکار مجاز نیست"}</small>
          </article>)}</div>
    </section>
    <section className="language-readiness" aria-label="آمادگی زبان‌های نقشه">
      <div className="language-readiness-heading"><span><strong>آمادگی زبان‌ها</strong>
        <small>{languageReadiness
          ? `${languageReadiness.modelEvaluation.summary.acceptable.toLocaleString("fa-IR")} پاسخ قابل‌قبول از ${languageReadiness.modelEvaluation.summary.samples.toLocaleString("fa-IR")} آزمون مدل`
          : "در حال خواندن آزمون‌های پایه"}</small></span>
        <b className="approval-lock">درج خودکار بسته است</b></div>
      <div className="language-readiness-list">{languageReadiness?.languages.map((language) =>
        <article key={language.language} className={language.status === "quality_gap" ? "has-gap" : "baseline-passed"}>
          <div><strong>{language.label}</strong><bdi>{language.language}</bdi></div>
          <span>{language.passRate.toLocaleString("fa-IR")}٪ آزمون پایه</span>
          <small>پوشش مرجع: {language.reference.resolved.toLocaleString("fa-IR")} از {language.reference.samples.toLocaleString("fa-IR")}</small>
          <small>دقت پاسخ واژه‌نامه: {language.reference.precision.toLocaleString("fa-IR")}٪</small>
          <small>مدل آفلاین: {language.model?.acceptableRate.toLocaleString("fa-IR") ?? "—"}٪ قابل‌قبول</small>
        </article>)}</div>
      <p>موارد پوشش‌نداده‌شده باید با مدل آفلاین آزموده شوند. پس از آن نیز تأیید روی دادهٔ واقعی کارفرما برای ثبت خودکار لازم است.</p>
    </section>
    <section className="workspace">
      <aside className="data-panel">
        <div className="panel-heading"><div><p className="eyebrow">فهرست عوارض</p><h2>کنترل رکوردها</h2></div>
          <button className="quiet-button" onClick={scanQueue}>اجرای پویش</button></div>
        <div className="filters"><label className="search-field"><span className="sr-only">جست‌وجوی نام یا شناسه</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی نام یا شناسه…"/></label>
          <div className="filter-row"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="فیلتر وضعیت">
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select value={layerFilter} onChange={(event) => setLayerFilter(event.target.value)} aria-label="فیلتر لایه"><option value="all">همه لایه‌ها</option>
              {dataset && Object.keys(dataset.meta.layers).map((layer) => <option key={layer} value={layer}>{layer}</option>)}</select></div></div>
        <div className="batch-actions" aria-label="عملیات ترجمهٔ گروهی">
          <button className="batch-primary" onClick={runOnlineBatch} disabled={isTranslating}>{isTranslating ? "در حال پردازش…" : "اجرای آزمایشی ۵ نام نخست"}</button>
          <button onClick={runDemoBatch} disabled={isTranslating || !uniqueQueue.length}>اجرای نمونه</button>
          <button onClick={exportSqlPatch}>خروجی SQL</button>
        </div>
        <div className="result-summary">نمایش {results.length.toLocaleString("fa-IR")} نتیجهٔ نخست</div>
        <div className="record-list">{results.map((feature) => <button key={feature.id}
          className={`record-card ${selected?.id === feature.id ? "is-selected" : ""}`} onClick={() => focusFeature(feature)}>
          <span className={`record-status status-${feature.properties.status}`}/><span className="record-copy">
            <strong dir="auto">{feature.properties.translated_name || feature.properties.source_name}</strong>
            {feature.properties.translated_name && <small dir="auto">{feature.properties.source_name}</small>}
            <small><bdi>{feature.properties.layer}</bdi> · شناسهٔ <bdi>{feature.properties.osm_id}</bdi></small>
          </span></button>)}</div>
      </aside>
      <div className="map-panel">
        <div className="map-legend"><span><i className="legend-pending"/> در انتظار</span><span><i className="legend-translated"/> ترجمه‌شده</span><span><i className="legend-empty"/> بدون نام</span></div>
        <svg className={`map-canvas vector-map ${isMapDragging ? "is-dragging" : ""}`} viewBox={viewBounds.join(" ")}
          preserveAspectRatio="xMidYMid meet" aria-label="نقشه عوارض فایل کارفرما"
          onWheel={handleMapWheel} onPointerDown={startMapDrag} onPointerMove={moveMap}
          onPointerUp={finishMapDrag} onPointerCancel={finishMapDrag}
          onDoubleClick={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
            zoomMap(.62, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height); }}>
          <rect className="map-background" x={viewBounds[0]} y={viewBounds[1]} width={viewBounds[2]} height={viewBounds[3]}/>
          {mapFeatures.map((feature) => {
            const kind = geometryKind(feature.geometry);
            return <path key={feature.id} d={geometryPath(feature.geometry)}
              className={`geom geom-${kind} geom-${feature.properties.layer} geom-${feature.properties.status} ${feature.properties.source_name ? "is-named" : ""} ${selected?.id === feature.id ? "is-selected" : ""}`}
              vectorEffect="non-scaling-stroke" fillRule="evenodd"
              onClick={() => feature.properties.source_name && openMapFeature(feature)} />;
          })}
          <g className="map-labels" aria-hidden="true">
            {mapLabels.map((label) => <text key={label.id} x={label.x} y={label.y}
              className={`map-label ${label.translated ? "is-translated" : "is-source"}`}
              fontSize={mapLabelSize} strokeWidth={mapLabelSize * .34} textAnchor="middle"
              dominantBaseline="central" onClick={() => { const feature = mapFeatureById.get(label.id);
                if (feature) openMapFeature(feature); }}>{label.text}</text>)}
          </g>
        </svg>
        <div className="map-controls" aria-label="کنترل بزرگ‌نمایی نقشه">
          <button onClick={() => zoomMap(.68)} aria-label="بزرگ‌نمایی">+</button>
          <button onClick={() => zoomMap(1.47)} aria-label="کوچک‌نمایی">−</button>
          <button onClick={resetMap} aria-label="نمایش کامل نقشه">⌂</button>
        </div>
        <div className="map-attribution">دادهٔ آزمایشی کارفرما</div>
        {selected && <article className="feature-drawer"><button className="drawer-close" onClick={() => setSelected(null)} aria-label="بستن جزئیات">×</button>
          <p className="eyebrow">جزئیات عارضه</p><h3 dir="auto">{selected.properties.translated_name || selected.properties.source_name}</h3>
          <dl><div><dt>نام مبدأ</dt><dd dir="auto">{selected.properties.source_name}</dd></div>
            <div><dt>ترجمه</dt><dd>{selected.properties.translated_name || "هنوز ثبت نشده"}</dd></div>
            <div><dt>لایه</dt><dd><bdi>{selected.properties.layer}</bdi></dd></div>
            <div><dt>شناسه</dt><dd><bdi>{selected.properties.osm_type}-{selected.properties.osm_id}</bdi></dd></div>
            <div><dt>وضعیت</dt><dd>{statusLabels[selected.properties.status]}</dd></div></dl>
          <button className="primary-button" onClick={translateNow} disabled={isTranslating || !selected.properties.source_name}>{isTranslating ? "در حال ترجمه…" : "ترجمه با مدل آفلاین"}</button>
          <form className="manual-form" onSubmit={saveManual}><label htmlFor="manual-translation">پیش‌نویس ترجمه</label><div>
            <input id="manual-translation" value={manualTranslation} onChange={(event) => setManualTranslation(event.target.value)} placeholder="نام فارسی را وارد کنید"/><button type="submit">ثبت پیش‌نویس</button></div></form>
          {dataset?.meta.live && stagedFeatureIds.has(selected.id) && <button className="primary-button"
            onClick={persistSelectedTranslation} disabled={isPersisting}>{isPersisting ? "در حال ثبت…" : "ثبت ترجمهٔ بازبینی‌شده در پایگاه‌داده"}</button>}
          {dataset?.meta.live && <section className="translation-history" aria-label="تاریخچه ترجمه">
            <div className="history-heading"><strong>تاریخچهٔ تغییرات</strong><button onClick={() => void loadFeatureHistory(selected)}
              disabled={historyLoading}>{historyLoading ? "در حال خواندن" : "تازه‌سازی"}</button></div>
            {!historyLoading && !historyEntries.length && <p>هنوز تغییری برای این عارضه ثبت نشده است.</p>}
            <div className="history-list">{historyEntries.map((entry) => {
              const canRollback = !entry.revertedAt && entry.newTranslation === (selected.properties.translated_name || "");
              return <article key={entry.id} className={entry.revertedAt ? "is-reverted" : ""}>
                <div><strong>{entry.reason === "rollback" ? "بازگردانی" : entry.reason === "edit_requested"
                  ? "بازترجمه" : entry.reason === "new_name" ? "نام جدید" : "ثبت بازبینی‌شده"}</strong>
                  <time dateTime={entry.createdAt}>{new Intl.DateTimeFormat("fa-IR", { dateStyle: "short",
                    timeStyle: "short" }).format(new Date(entry.createdAt))}</time></div>
                <p><span>{entry.previousTranslation || "بدون ترجمه"}</span><b>←</b><span>{entry.newTranslation || "بدون ترجمه"}</span></p>
                <small><bdi>{entry.provider}</bdi>{entry.revertedAt ? " · بازگردانده شده" : ""}</small>
                {canRollback && <button className="history-rollback" onClick={() => void rollbackTranslation(entry)}
                  disabled={rollbackId === entry.id}>{rollbackId === entry.id ? "در حال بازگردانی" : "بازگردانی این تغییر"}</button>}
              </article>;
            })}</div>
          </section>}
          <p className="drawer-note">ترجمه ابتدا در مرورگر می‌ماند. ثبت زنده فقط با دکمهٔ تأیید جداگانه انجام می‌شود و نام مبدأ و هندسه را تغییر نمی‌دهد.</p></article>}
      </div>
    </section>
    {connectionOpen && <div className="connection-overlay" role="presentation">
      <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <button className="job-close" onClick={() => !connectionBusy && setConnectionOpen(false)}
          disabled={Boolean(connectionBusy)} aria-label="بستن پنجره">×</button>
        <div className="connection-heading"><div><p className="eyebrow">منبع دادهٔ سامانه</p>
          <h2 id="connection-title">اتصال و آزمون پایگاه داده</h2></div>
          <span className={`connection-badge ${activeConnection ? "is-connected" : ""}`}>
            {activeConnection ? "اتصال فعال" : "بدون اتصال"}</span></div>
        <p className="connection-intro">آزمون فقط ساختار و سطح دسترسی را می‌خواند و هیچ رکوردی را تغییر نمی‌دهد. گذرواژه پس از ارسال دوباره نمایش داده نمی‌شود.</p>
        <form className="connection-form" onSubmit={testDatabaseConnection}>
          <label><span>نشانی سرور</span><input dir="ltr" required value={connectionForm.host}
            onChange={(event) => setConnectionForm({ ...connectionForm, host: event.target.value })}
            placeholder="database-server"/></label>
          <label><span>درگاه</span><input dir="ltr" required inputMode="numeric" value={connectionForm.port}
            onChange={(event) => setConnectionForm({ ...connectionForm, port: event.target.value })}/></label>
          <label><span>نام پایگاه داده</span><input dir="ltr" required value={connectionForm.database}
            onChange={(event) => setConnectionForm({ ...connectionForm, database: event.target.value })}/></label>
          <label><span>نام کاربری</span><input dir="ltr" required autoComplete="username" value={connectionForm.user}
            onChange={(event) => setConnectionForm({ ...connectionForm, user: event.target.value })}/></label>
          <label className="connection-password"><span>گذرواژه</span><input dir="ltr" type="password"
            autoComplete="current-password" value={connectionForm.password}
            onChange={(event) => setConnectionForm({ ...connectionForm, password: event.target.value })}
            placeholder={activeConnection?.passwordConfigured ? "برای اتصال فعلی می‌تواند خالی بماند" : "گذرواژه را وارد کنید"}/></label>
          <label><span>نام طرح</span><input dir="ltr" required value={connectionForm.schema}
            onChange={(event) => setConnectionForm({ ...connectionForm, schema: event.target.value })}/></label>
          <label><span>نام جدول</span><input dir="ltr" required value={connectionForm.table}
            onChange={(event) => setConnectionForm({ ...connectionForm, table: event.target.value })}/></label>
          <label><span>اتصال امن</span><select value={connectionForm.sslMode}
            onChange={(event) => setConnectionForm({ ...connectionForm,
              sslMode: event.target.value as DatabaseConnectionForm["sslMode"] })}>
            <option value="disable">بدون رمزنگاری؛ شبکهٔ محلی</option>
            <option value="require">رمزنگاری بدون بررسی گواهی</option>
            <option value="verify-full">رمزنگاری با بررسی کامل گواهی</option>
          </select></label>
          <label className="remember-connection"><input type="checkbox" checked={connectionForm.remember}
            onChange={(event) => setConnectionForm({ ...connectionForm, remember: event.target.checked })}/>
            <span>پس از راه‌اندازی دوباره نیز از همین اتصال استفاده شود</span></label>
          <div className="connection-actions"><button type="submit" className="connection-test"
            disabled={Boolean(connectionBusy)}>{connectionBusy === "testing" ? "در حال آزمون…" : "آزمایش اتصال"}</button>
            <button type="button" className="connection-activate" onClick={() => void activateDatabaseConnection()}
              disabled={connectionBusy !== "" || !connectionInspection?.readyForAutomation}>
              {connectionBusy === "activating" ? "در حال فعال‌سازی…" : "فعال‌سازی این اتصال"}</button></div>
        </form>
        {connectionBusy === "loading" && <p className="connection-loading">در حال خواندن تنظیمات اتصال…</p>}
        {connectionInspection && <section className={`connection-report ${connectionInspection.ok ? "is-success" : "is-error"}`}
          aria-live="polite">
          <div className="connection-report-title"><strong>{connectionInspection.readyForAutomation
            ? "اتصال برای ترجمهٔ خودکار آماده است" : connectionInspection.ok
              ? "اتصال برقرار است، اما همهٔ پیش‌نیازها آماده نیست" : "آزمون اتصال ناموفق بود"}</strong>
            {typeof connectionInspection.latencyMs === "number" && <span>
              پاسخ در {connectionInspection.latencyMs.toLocaleString("fa-IR")} میلی‌ثانیه</span>}</div>
          {connectionInspection.message && <p>{connectionInspection.message}</p>}
          {connectionInspection.checks && <div className="connection-checks">{connectionInspection.checks.map((check) =>
            <div key={check.key} className={check.ok ? "is-ok" : "is-failed"}><i/>
              <span>{check.label}</span><strong>{check.ok ? "تأیید شد" : "نیازمند اصلاح"}</strong></div>)}</div>}
          {connectionInspection.stats && <div className="connection-stats">
            <div><span>کل رکوردها</span><strong>{connectionInspection.stats.total.toLocaleString("fa-IR")}</strong></div>
            <div><span>دارای نام</span><strong>{connectionInspection.stats.named.toLocaleString("fa-IR")}</strong></div>
            <div><span>در انتظار</span><strong>{connectionInspection.stats.pending.toLocaleString("fa-IR")}</strong></div>
            <div><span>علامت ویرایش</span><strong>{connectionInspection.stats.requestedEdits.toLocaleString("fa-IR")}</strong></div>
          </div>}
          {connectionInspection.missingColumns?.length ? <p>ستون‌های پیدا نشده: <bdi>{connectionInspection.missingColumns.join(", ")}</bdi></p> : null}
          {connectionInspection.serverVersion && <small>نسخهٔ پایگاه داده: <bdi>{connectionInspection.serverVersion}</bdi>
            {connectionInspection.postgisVersion ? <> · نسخهٔ مکانی: <bdi>{connectionInspection.postgisVersion}</bdi></> : null}</small>}
        </section>}
      </section>
    </div>}
    {fullFileOpen && <div className="job-overlay" role="presentation">
      <section className="job-dialog" role="dialog" aria-modal="true" aria-labelledby="job-title">
        <button className="job-close" onClick={() => jobStatus !== "running" && setFullFileOpen(false)}
          disabled={jobStatus === "running"} aria-label="بستن پنجره">×</button>
        <p className="eyebrow">پردازش سراسری</p><h2 id="job-title">ترجمه و تولید فایل کامل</h2>
        <p className="job-intro">فایل روی همین دستگاه خوانده و بازنویسی می‌شود. نام، لایه و کلاس رکوردهای لازم فقط به مدل آفلاین همین سرور فرستاده می‌شوند.</p>
        <label className="file-picker"><span>{sqlJob ? "انتخاب فایل دیگر" : "انتخاب فایل پشتیبان"}</span>
          <input type="file" accept=".sql,text/plain,application/sql" onChange={chooseSqlFile} disabled={jobStatus === "running"}/></label>
        {sqlJob && <>
          <div className="job-file"><strong dir="ltr">{sqlJob.fileName}</strong><span>{(new Blob([sqlJob.text]).size / 1024 / 1024).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} مگابایت</span></div>
          <div className="job-stats">
            <div><span>کل ردیف‌ها</span><strong>{sqlJob.scan.stats.total.toLocaleString("fa-IR")}</strong></div>
            <div><span>بدون نام</span><strong>{sqlJob.scan.stats.noSource.toLocaleString("fa-IR")}</strong></div>
            <div><span>ترجمهٔ موجود</span><strong>{sqlJob.scan.stats.translated.toLocaleString("fa-IR")}</strong></div>
            <div><span>نام یکتا در صف</span><strong>{sqlJob.scan.stats.uniqueCandidates.toLocaleString("fa-IR")}</strong></div>
          </div>
          <div className="job-progress" aria-label="پیشرفت ترجمه">
            <div><span>پیشرفت</span><strong>{jobProgress.completed.toLocaleString("fa-IR")} از {jobProgress.total.toLocaleString("fa-IR")}</strong></div>
            <progress max={Math.max(jobProgress.total, 1)} value={jobProgress.completed}/><small>{jobPercent.toLocaleString("fa-IR")} درصد</small>
          </div>
        </>}
        <p className={`job-message is-${jobStatus}`} aria-live="polite">{jobMessage}</p>
        <div className="job-buttons">
          {jobStatus !== "running" ? <button className="job-start" onClick={runFullTranslation} disabled={!sqlJob || jobStatus === "complete"}>
            {jobStatus === "paused" || jobProgress.completed > 0 ? "ادامهٔ ترجمهٔ آفلاین" : "شروع ترجمهٔ آفلاین"}</button>
            : <button className="job-stop" onClick={pauseFullTranslation}>توقف امن</button>}
          <button className="job-preview" onClick={showFullTranslationsOnMap} disabled={!sqlJob || jobStatus !== "complete"}>نمایش نتیجه روی نقشه</button>
          <button onClick={downloadFullSql} disabled={!sqlJob || jobStatus !== "complete"}>دریافت فایل کامل</button>
        </div>
        <p className="job-note">اگر صفحه بسته شود، ترجمه‌های پایان‌یافته در حافظهٔ همین مرورگر باقی می‌مانند. برای ادامه، دوباره همین فایل را انتخاب کنید.</p>
      </section>
    </div>}
  </main>;
}
