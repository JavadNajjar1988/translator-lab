const sourceRules = [
  { source: /\bAvenue\b/i, translated: /خیابان/, label: "Avenue=خیابان" },
  { source: /\bRue\b/i, translated: /خیابان/, label: "Rue=خیابان" },
  { source: /\bBoulevard\b/i, translated: /بلوار/, label: "Boulevard=بلوار" },
  { source: /\bImpasse\b/i, translated: /بن‌بست/, label: "Impasse=بن‌بست" },
  { source: /(^Stade\b|\b(?:du|de|des) Stade\b)/i, translated: /ورزشگاه/, label: "Stade=ورزشگاه" },
  { source: /(^Parking\b|\bParking$)/i, translated: /پارکینگ/, label: "Parking=پارکینگ" },
  { source: /(^Gare\b|\bde la Gare\b)/i, translated: /ایستگاه/, label: "Gare=ایستگاه" },
  { source: /(^H[oô]pital\b|\bde l['’]H[oô]pital\b)/i, translated: /بیمارستان/, label: "Hôpital=بیمارستان" },
  { source: /(^Jardin\b|\bdu Jardin\b|\bde l['’]Jardin\b)/i, translated: /(باغ|بوستان)/, label: "Jardin=باغ" },
  { source: /(^Place\b|\bde la Place\b)/i, translated: /میدان/, label: "Place=میدان" },
  { source: /(^Port\s+(?:de|du)\b|\bdu Port\b|\bde Port\b)/i, translated: /بندر/, label: "Port=بندر" },
  { source: /(^Pont\b|\bdu Pont\b|\bPont\s)/i, translated: /پل/, label: "Pont=پل" },
  { source: /\bPlage\b/i, translated: /ساحل/, label: "Plage=ساحل" },
  { source: /(^Chemin\b|\bdu Chemin\b)/i, translated: /(مسیر|راه)/, label: "Chemin=مسیر" },
  { source: /\bCaff[eè]\b/i, translated: /کافه/, label: "Caffè=کافه" },
  { source: /^Caff[eè]\s+Milano$/i, translated: /کافه\s+میلانو/, label: "Caffè Milano=کافه میلانو" },
  { source: /\bObservato(?:ire|ry)\b/i, translated: /رصدخانه/,
    label: "Observatoire/Observatory=رصدخانه" },
  { source: /\bCartograph(?:ique|ic)\b/i, translated: /نقشه(?:‌|-|\s)?نگار/,
    label: "Cartographique/Cartographic=نقشه‌نگاری" },
];

// Short international markers commonly used as part of map feature names.
// This list is deliberately bounded: it guards well-known labels without
// pretending that arbitrary proper names can be validated by transliteration.
const properTokenRules = [
  { source: /\bAlpha\b/i, translated: /آلفا/, label: "Alpha=آلفا" },
  { source: /\bBeta\b/i, translated: /بتا/, label: "Beta=بتا" },
  { source: /\bGamma\b/i, translated: /گاما/, label: "Gamma=گاما" },
  { source: /\bDelta\b/i, translated: /دلتا/, label: "Delta=دلتا" },
];

const classRules = [
  { className: /^(?:art_gallery|gallery)$/i, translated: /(گالری|نگارخانه)/,
    label: "class:art_gallery=گالری" },
];

const outputRules = [
  { invalid: /\p{Script=Latin}/u, label: "target:latin-contamination" },
  { invalid: /^[\p{P}\p{S}]/u, label: "target:leading-punctuation" },
  { invalid: /\b(?:world|kgm|canada|brazil)\b/iu, label: "target:metadata-contamination" },
];

function text(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function translationQualityIssues(item, translatedName) {
  const sourceName = text(item?.sourceName ?? item?.source_name);
  const className = text(item?.className ?? item?.class);
  const translated = text(translatedName);
  return [
    ...sourceRules.filter((rule) => rule.source.test(sourceName) && !rule.translated.test(translated)),
    ...properTokenRules.filter((rule) => rule.source.test(sourceName) && !rule.translated.test(translated)),
    ...classRules.filter((rule) => rule.className.test(className) && !rule.translated.test(translated)),
    ...outputRules.filter((rule) => rule.invalid.test(translated)),
  ].map((rule) => rule.label);
}
