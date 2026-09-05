function normalized(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

const exactGenericNames = new Map([
  ["avenue", "خیابان"], ["rue", "خیابان"], ["street", "خیابان"], ["straße", "خیابان"],
  ["strasse", "خیابان"], ["شارع", "خیابان"], ["רחוב", "خیابان"],
  ["boulevard", "بلوار"], ["impasse", "بن‌بست"], ["cul-de-sac", "بن‌بست"],
  ["station", "ایستگاه"], ["gare", "ایستگاه"], ["bahnhof", "ایستگاه"], ["estación", "ایستگاه"],
  ["محطة", "ایستگاه"], ["תחנה", "ایستگاه"], ["駅", "ایستگاه"], ["站", "ایستگاه"],
  ["airport", "فرودگاه"], ["aéroport", "فرودگاه"], ["flughafen", "فرودگاه"],
  ["aeropuerto", "فرودگاه"], ["مطار", "فرودگاه"], ["机场", "فرودگاه"], ["空港", "فرودگاه"],
  ["hospital", "بیمارستان"], ["hôpital", "بیمارستان"], ["krankenhaus", "بیمارستان"],
  ["مستشفى", "بیمارستان"], ["医院", "بیمارستان"], ["病院", "بیمارستان"],
  ["park", "پارک"], ["parc", "پارک"], ["parque", "پارک"], ["حديقة", "پارک"],
  ["公园", "پارک"], ["公園", "پارک"], ["garden", "باغ"], ["jardin", "باغ"],
  ["bridge", "پل"], ["pont", "پل"], ["brücke", "پل"], ["جسر", "پل"], ["大桥", "پل"],
  ["square", "میدان"], ["place", "میدان"], ["plaza", "میدان"], ["platz", "میدان"],
  ["ميدان", "میدان"], ["广场", "میدان"], ["広場", "میدان"],
  ["port", "بندر"], ["harbor", "بندر"], ["harbour", "بندر"], ["hafen", "بندر"],
  ["ميناء", "بندر"], ["港", "بندر"], ["beach", "ساحل"], ["plage", "ساحل"],
  ["playa", "ساحل"], ["شاطئ", "ساحل"], ["海滩", "ساحل"],
  ["stadium", "ورزشگاه"], ["stade", "ورزشگاه"], ["stadion", "ورزشگاه"],
  ["estadio", "ورزشگاه"], ["ملعب", "ورزشگاه"], ["体育场", "ورزشگاه"],
  ["university", "دانشگاه"], ["université", "دانشگاه"], ["universität", "دانشگاه"],
  ["جامعة", "دانشگاه"], ["大学", "دانشگاه"], ["museum", "موزه"], ["musée", "موزه"],
  ["museo", "موزه"], ["متحف", "موزه"], ["博物馆", "موزه"],
  ["river", "رود"], ["rivière", "رود"], ["río", "رود"], ["نهر", "رود"], ["河", "رود"],
  ["lake", "دریاچه"], ["lac", "دریاچه"], ["lago", "دریاچه"], ["بحيرة", "دریاچه"], ["湖", "دریاچه"],
  ["mountain", "کوه"], ["mount", "کوه"], ["berg", "کوه"], ["جبل", "کوه"], ["山", "کوه"],
  ["sea", "دریا"], ["mer", "دریا"], ["meer", "دریا"], ["بحر", "دریا"], ["海", "دریا"],
]);

const genericMarkers = [...exactGenericNames.keys()].sort((a, b) => b.length - a.length);

function isIdentifier(sourceName) {
  const value = String(sourceName || "").trim();
  if (!value || /\s/.test(value)) return false;
  return /\d/.test(value) && /^[\p{L}\p{N}._:/-]+$/u.test(value);
}

function splitOnMarker(sourceName, marker) {
  const source = normalized(sourceName);
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(marker)
    ? new RegExp(`^(.*)${escaped}$|^${escaped}(.*)$`, "u")
    : new RegExp(`^(.*?)(?:\\s+|^|[-–—])${escaped}(?:\\s+|$|[-–—])(.*)$`, "iu");
  const match = source.match(pattern);
  if (!match) return "";
  return [match[1], match[2]].filter(Boolean).join(" ").trim()
    .replace(/^(?:of|de|du|des|del|la|le|el|von|der|the)\s+/iu, "")
    .replace(/\s+(?:of|de|du|des|del|la|le|el|von|der|the)$/iu, "").trim();
}

export function classifyMapName(item) {
  const sourceName = String(item?.sourceName ?? item?.source_name ?? "").normalize("NFKC").trim();
  const source = normalized(sourceName);
  if (!source) return { kind: "empty", properCore: "", requiresJudge: false };
  if (isIdentifier(sourceName)) return { kind: "identifier", properCore: "", requiresJudge: false };
  if (exactGenericNames.has(source)) return { kind: "generic", properCore: "", requiresJudge: false };
  for (const marker of genericMarkers) {
    const properCore = splitOnMarker(sourceName, marker);
    if (properCore) return { kind: "mixed", properCore, genericMarker: marker, requiresJudge: true };
  }
  return { kind: "proper", properCore: sourceName, requiresJudge: true };
}

export function resolveControlledNames(items) {
  const hits = new Map();
  for (const item of items) {
    const classification = classifyMapName(item);
    const sourceName = String(item.sourceName ?? item.source_name ?? "").normalize("NFKC").trim();
    if (classification.kind === "identifier") {
      hits.set(item.key, { key: item.key, translatedName: sourceName, strategy: "transliteration",
        provider: "identifier-preserved", nameKind: "identifier", reviewRequired: false });
      continue;
    }
    if (classification.kind !== "generic") continue;
    hits.set(item.key, { key: item.key, translatedName: exactGenericNames.get(normalized(sourceName)),
      strategy: "translation", provider: "controlled-generic-memory", nameKind: "generic",
      reviewRequired: false });
  }
  return hits;
}

export function controlledNameRouterStatus() {
  return { enabled: true, exactGenericNames: exactGenericNames.size,
    policies: ["generic-controlled", "identifier-preserved", "proper-name-review"] };
}
