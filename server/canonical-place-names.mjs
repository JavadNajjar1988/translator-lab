import dataset from "./data/canonical-place-names.mjs";
import supplements from "./data/canonical-place-supplements.mjs";
import wikidataGazetteer from "./data/wikidata-place-gazetteer.mjs";
import blockedAliasValues from "./data/canonical-place-blocked-aliases.mjs";
import coordinateDisambiguationSmoke from "./data/coordinate-disambiguation-smoke.mjs";
import identitySupplements from "./data/canonical-place-identity-supplements.mjs";

export const coordinateResolutionPolicy = Object.freeze({ maximumDistanceKilometers: 100,
  minimumGapKilometers: 25, relativeGap: 0.25 });

function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function normalizedCanonicalId(item) {
  const value = item.wikidataId ?? item.wikidata_id ?? item.wikidata ?? item.properties?.wikidata;
  const match = /(?:wikidata:)?(Q\d+)/i.exec(String(value || "").trim());
  return match ? `wikidata:${match[1].toUpperCase()}` : "";
}

function itemCoordinates(item) {
  const provided = Array.isArray(item.coordinates) ? item.coordinates : null;
  const longitude = Number(provided?.[0] ?? item.longitude ?? item.lon);
  const latitude = Number(provided?.[1] ?? item.latitude ?? item.lat);
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
    ? [longitude, latitude] : null;
}

function distanceKilometers(first, second) {
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(second[1] - first[1]);
  const longitudeDistance = radians(second[0] - first[0]);
  const value = Math.sin(latitudeDistance / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1])) * Math.sin(longitudeDistance / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function geographicContext(item) {
  const layer = normalized(item.layer);
  const className = normalized(item.className ?? item.class);
  if (!layer && !className) return true;
  if (["place", "boundary", "country", "region", "water", "water_name", "water_name_detail",
    "mountain_peak", "natural"].includes(layer)) return true;
  return new Set(["continent", "country", "state", "province", "region", "capital", "city", "town",
    "village", "municipality", "suburb", "locality", "neighborhood", "neighbourhood", "admin1",
    "river", "stream", "canal", "lake", "reservoir", "sea", "ocean", "gulf", "bay", "strait",
    "channel", "sound", "lagoon", "fjord", "reef", "mountain", "mountain_range", "peak", "island"])
    .has(className);
}

const contextKindGroups = {
  country: ["country"], city: ["city", "capital"], capital: ["capital", "city"],
  admin1: ["admin1"], state: ["admin1"], province: ["admin1"], governorate: ["admin1"], prefecture: ["admin1"],
  river: ["river", "river_intermittent"], stream: ["river", "river_intermittent"], canal: ["canal"],
  lake: ["lake", "alkaline_lake", "lake_centerline"], reservoir: ["reservoir"],
  sea: ["sea"], ocean: ["ocean"], gulf: ["gulf"], bay: ["bay"], strait: ["strait"],
  channel: ["channel"], sound: ["sound"], lagoon: ["lagoon"], fjord: ["fjord"], reef: ["reef"],
  mountain: ["mountain", "range_mtn"], mountain_range: ["range_mtn"], peak: ["mountain"],
  island: ["island", "island_group"],
};

function contextCandidates(matches, item) {
  if (!matches?.size) return null;
  const className = normalized(item.className ?? item.class).replace(/[\s-]+/g, "_");
  const expectedKinds = contextKindGroups[className] || [];
  if (matches.size === 1) {
    const entry = matches.values().next().value;
    const kinds = entry.kinds || [entry.kind];
    return expectedKinds.length && !kinds.some((kind) => expectedKinds.includes(kind)) ? [] : [entry];
  }
  return expectedKinds.length ? [...matches.values()].filter((entry) => {
    const kinds = entry.kinds || [entry.kind];
    return kinds.some((kind) => expectedKinds.includes(kind));
  }) : [...matches.values()];
}

function selectedEntry(matches, item) {
  const candidates = contextCandidates(matches, item) || [];
  if (candidates.length === 1) return { entry: candidates[0], resolution: "alias" };
  const location = itemCoordinates(item);
  const located = candidates.filter((entry) => Array.isArray(entry.coordinates)
    && entry.coordinates.length === 2 && entry.coordinates.every(Number.isFinite));
  if (location && located.length === candidates.length && located.length > 1) {
    const ranked = located.map((entry) => ({ entry, distance: distanceKilometers(location, entry.coordinates) }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = ranked[0];
    const second = ranked[1];
    const safeGap = second.distance - nearest.distance >= Math.max(
      coordinateResolutionPolicy.minimumGapKilometers,
      nearest.distance * coordinateResolutionPolicy.relativeGap);
    if (nearest.distance <= coordinateResolutionPolicy.maximumDistanceKilometers && safeGap) {
      return { entry: nearest.entry, resolution: "coordinate" };
    }
  }
  const targets = new Map(candidates.map((entry) => [normalized(entry.target_name), entry]));
  return targets.size === 1 ? { entry: targets.values().next().value, resolution: "alias" } : null;
}

const compositeRules = [
  { target: "فرودگاه بین‌المللی", prefixes: ["international airport of ", "international airport ",
    "aéroport international de ", "aeropuerto internacional de ", "مطار دولي ", "נמל התעופה הבינלאומי "],
  suffixes: [" international airport", "国际机场", "国際空港", " 국제공항"] },
  { target: "فرودگاه", prefixes: ["airport of ", "airport ", "flughafen ", "aéroport de ", "aéroport ",
    "aeropuerto de ", "aeropuerto ", "аэропорт ", "مطار ", "שדה התעופה "],
  suffixes: [" airport", " flughafen", "机场", "空港", " 공항"] },
  { target: "ایستگاه", prefixes: ["railway station of ", "railway station ", "station of ", "station ",
    "gare de ", "gare ", "bahnhof ", "estación de ", "estación ", "вокзал ", "станция ", "محطة ", "תחנת "],
  suffixes: [" railway station", " station", " bahnhof", "駅", "站", " 역"] },
  { target: "بندر", prefixes: ["port of ", "port ", "hafen ", "port de ", "puerto de ", "puerto ",
    "порт ", "ميناء ", "נמל "], suffixes: [" port", " hafen", "港", " 항"] },
  { target: "دانشگاه", prefixes: ["university of ", "university ", "universität ", "université de ",
    "universidad de ", "университет ", "جامعة ", "אוניברסיטת "],
  suffixes: [" university", " universität", "大学", " 대학교"] },
  { target: "بیمارستان", prefixes: ["hospital of ", "hospital ", "krankenhaus ", "hôpital de ", "hôpital ",
    "hospital de ", "больница ", "مستشفى ", "בית החולים "], suffixes: [" hospital", "医院", "病院", " 병원"] },
  { target: "موزه", prefixes: ["museum of ", "museum ", "museum von ", "musée de ", "musée ",
    "museo de ", "музей ", "متحف ", "מוזיאון "], suffixes: [" museum", "博物馆", "博物館", " 박물관"] },
  { target: "پارک", prefixes: ["park of ", "park ", "parc de ", "parc ", "parque de ", "parque ",
    "парк ", "حديقة ", "פארק "], suffixes: [" park", "公园", "公園", " 공원"] },
  { target: "پل", prefixes: ["bridge of ", "bridge ", "brücke ", "pont de ", "pont ", "puente de ",
    "puente ", "мост ", "جسر ", "גשר "], suffixes: [" bridge", " bridge", "大桥", "大橋", " 다리"] },
  { target: "میدان", prefixes: ["square of ", "square ", "platz ", "place de ", "place ", "plaza de ",
    "plaza ", "площадь ", "ميدان ", "כיכר "], suffixes: [" square", " plaza", "广场", "広場", " 광장"] },
  { target: "رود", prefixes: ["river ", "river of ", "rivière ", "río ", "fluss ", "река ", "نهر ", "נהר "],
    suffixes: [" river", " river", " fluss", " rivière", " río", " река", "河", "川", " 강"] },
  { target: "دریاچه", prefixes: ["lake ", "lake of ", "lac ", "see ", "lago ", "озеро ", "بحيرة ", "אגם "],
    suffixes: [" lake", " see", " lac", " lago", " озеро", "湖", " 호수"] },
  { target: "کوه", prefixes: ["mount ", "mountain ", "mont ", "berg ", "monte ", "гора ", "جبل ", "הר "],
    suffixes: [" mountain", " mount", " berg", " monte", " гора", "山", " 산"] },
  { target: "دریا", prefixes: ["sea of ", "sea ", "mer de ", "meer ", "mar de ", "море ", "بحر ", "ים "],
    suffixes: [" sea", " meer", " mer", " mar", " море", "海", " 해"] },
  { target: "خلیج", prefixes: ["gulf of ", "gulf ", "golfe de ", "golfo de ", "залив ", "خليج ", "מפרץ "],
    suffixes: [" gulf", " gulf", "湾", " 만"] },
  { target: "ساحل", prefixes: ["beach of ", "beach ", "plage de ", "plage ", "playa de ", "playa ",
    "пляж ", "شاطئ ", "חוף "], suffixes: [" beach", " plage", " playa", "海滩", "海岸", " 해변"] },
  { target: "ورزشگاه", prefixes: ["stadium of ", "stadium ", "stadion ", "stade de ", "stade ",
    "estadio de ", "estadio ", "стадион ", "ملعب ", "אצטדיון "], suffixes: [" stadium", " stadion", "体育场", "競技場", " 경기장"] },
];

const blockedCompositeClasses = new Set(["shop", "clothing_store", "cafe", "restaurant", "fast_food",
  "company", "office", "brand"]);

function compositeContext(item) {
  return !blockedCompositeClasses.has(normalized(item.className ?? item.class));
}

function compositeCandidate(sourceName, rule) {
  const source = normalized(sourceName);
  for (const prefix of rule.prefixes) {
    const marker = normalized(prefix);
    const hasBoundary = !/\s$/.test(prefix) || source[marker.length] === " ";
    if (hasBoundary && source.startsWith(marker) && source.length > marker.length) {
      return source.slice(marker.length).trim();
    }
  }
  for (const suffix of rule.suffixes) {
    const marker = normalized(suffix);
    const boundaryIndex = source.length - marker.length - 1;
    const hasBoundary = !/^\s/.test(suffix) || source[boundaryIndex] === " ";
    if (hasBoundary && source.endsWith(marker) && source.length > marker.length) {
      return source.slice(0, -marker.length).trim();
    }
  }
  return "";
}

const conceptPrefixes = {
  "رود": ["رود ", "رودخانه "], "دریاچه": ["دریاچه "], "کوه": ["کوه ", "رشته‌کوه "],
  "رشته‌کوه": ["رشته‌کوه "], "دریا": ["دریا ", "دریای "], "اقیانوس": ["اقیانوس "],
  "خلیج": ["خلیج "], "ساحل": ["ساحل "],
};

const exactConcepts = {
  river: "رود", stream: "رود", canal: "کانال", lake: "دریاچه", reservoir: "دریاچه",
  sea: "دریا", ocean: "اقیانوس", gulf: "خلیج", bay: "خلیج", mountain: "کوه",
  mountain_range: "رشته‌کوه", peak: "کوه",
};

function compositeTranslation(targetName, concept) {
  const target = normalized(targetName);
  if ([`${concept} `, ...(conceptPrefixes[concept] || [])].some((prefix) => target.startsWith(prefix))) {
    return targetName;
  }
  return `${concept} ${targetName}`;
}

function exactTranslation(entry, item) {
  const className = normalized(item.className ?? item.class).replace(/[\s-]+/g, "_");
  const concept = exactConcepts[className];
  return concept ? compositeTranslation(entry.target_name, concept) : entry.target_name;
}

export function createCanonicalPlaceNames(source = dataset) {
  const aliases = new Map();
  const blockedAliases = source === dataset ? new Set(blockedAliasValues.map(normalized)) : new Set();
  const kinds = {};
  const baseEntries = (source.entries || []).map((entry) => source === dataset && supplements[entry.id]
    ? { ...entry, aliases: [...(entry.aliases || []), ...supplements[entry.id]] } : entry);
  const rawEntries = source === dataset
    ? [...baseEntries, ...wikidataGazetteer.entries, ...identitySupplements.entries] : baseEntries;
  const entries = rawEntries.map((entry) => source === dataset && identitySupplements.overrides[entry.id]
    ? { ...entry, ...identitySupplements.overrides[entry.id] } : entry);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const entriesByWikidataId = new Map();
  for (const entry of entries) {
    const match = /(?:^|:)(Q\d+)$/i.exec(String(entry.id || ""));
    if (!match) continue;
    const key = `wikidata:${match[1].toUpperCase()}`;
    const existing = entriesByWikidataId.get(key);
    if (!existing || String(entry.id).startsWith("wikidata:")) entriesByWikidataId.set(key, entry);
  }
  for (const entry of entries) {
    for (const kind of entry.kinds || [entry.kind]) kinds[kind] = (kinds[kind] || 0) + 1;
    for (const alias of entry.aliases || []) {
      const key = normalized(alias.value);
      if (!key) continue;
      if (!aliases.has(key)) aliases.set(key, new Map());
      aliases.get(key).set(entry.id, entry);
    }
  }
  const ambiguous = [...aliases.values()].filter((matches) => matches.size > 1).length;
  const coordinateResolvableAliases = [...aliases.values()].filter((matches) => matches.size > 1
    && [...matches.values()].every((entry) => Array.isArray(entry.coordinates))).length;

  function resolve(items) {
    const hits = new Map();
    for (const item of items) {
      const sourceName = item.sourceName ?? item.source_name;
      const sourceKey = normalized(sourceName);
      const canonicalId = normalizedCanonicalId(item);
      const identifiedCandidate = geographicContext(item) && canonicalId
        ? entriesById.get(canonicalId) || entriesByWikidataId.get(canonicalId) : null;
      const identifiedEntry = identifiedCandidate
        ? contextCandidates(new Map([[identifiedCandidate.id, identifiedCandidate]]), item)?.[0] : null;
      if (identifiedEntry) {
        hits.set(item.key, { key: item.key, translatedName: exactTranslation(identifiedEntry, item),
          strategy: "translation", provider: "canonical-place-identifier", canonicalId: identifiedEntry.id,
          resolution: "identifier" });
        continue;
      }
      if (blockedAliases.has(sourceKey)) continue;
      const matches = aliases.get(sourceKey);
      const exactMatch = geographicContext(item) ? selectedEntry(matches, item) : null;
      if (exactMatch) {
        const { entry, resolution } = exactMatch;
        hits.set(item.key, { key: item.key, translatedName: exactTranslation(entry, item), strategy: "translation",
          provider: resolution === "coordinate" ? "canonical-place-coordinate" : "canonical-place-memory",
          canonicalId: entry.id, resolution });
        continue;
      }
      // An exact but ambiguous alias must fail closed. Falling through to the
      // composite parser can silently reinterpret one of the ambiguous names.
      if (matches?.size) continue;
      if (!compositeContext(item)) continue;
      for (const rule of compositeRules) {
        const candidate = compositeCandidate(sourceName, rule);
        if (blockedAliases.has(candidate)) continue;
        const candidateMatches = aliases.get(candidate);
        const match = selectedEntry(candidateMatches, item);
        if (!match) continue;
        const entry = match.entry;
        hits.set(item.key, { key: item.key, translatedName: compositeTranslation(entry.target_name, rule.target),
          strategy: "mixed", provider: "canonical-place-composite", canonicalId: entry.id,
          concept: rule.target });
        break;
      }
    }
    return hits;
  }

  return { resolve, status: () => ({ loaded: true, entries: entries.length, aliases: aliases.size,
    languages: source.languages.length, ambiguous, targetLanguage: source.target_language,
    generatedAt: source.generated_at, compositeRules: compositeRules.length, kinds,
    coordinates: entries.filter((entry) => Array.isArray(entry.coordinates)).length,
    coordinateResolvableAliases,
    naturalEarthVersion: source.sources?.natural_earth_version || null,
    supplementalAliases: source === dataset ? Object.values(supplements).flat().length : 0,
    wikidataGazetteerEntries: source === dataset ? wikidataGazetteer.entries.length : 0,
    wikidataGazetteerAliases: source === dataset
      ? wikidataGazetteer.entries.reduce((sum, entry) => sum + entry.aliases.length, 0) : 0,
    wikidataGazetteerExcludedAmbiguous: source === dataset
      ? wikidataGazetteer.sources.excluded_ambiguous_aliases : 0,
    wikidataGazetteerCoordinates: source === dataset
      ? wikidataGazetteer.sources.entries_with_coordinates || 0 : 0,
    identitySupplementEntries: source === dataset ? identitySupplements.entries.length : 0,
    identitySupplementFetchedAt: source === dataset ? identitySupplements.fetchedAt : null,
    coordinateEvaluation: source === dataset ? coordinateDisambiguationSmoke : null,
    blockedAliases: blockedAliases.size }) };
}

export const canonicalPlaceNames = createCanonicalPlaceNames();
