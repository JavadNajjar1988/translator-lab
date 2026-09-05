const scriptMatchers = [
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["han", /\p{Script=Han}/u],
  ["hiragana", /\p{Script=Hiragana}/u],
  ["katakana", /\p{Script=Katakana}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["bengali", /\p{Script=Bengali}/u],
  ["gurmukhi", /\p{Script=Gurmukhi}/u],
  ["tamil", /\p{Script=Tamil}/u],
  ["telugu", /\p{Script=Telugu}/u],
  ["thai", /\p{Script=Thai}/u],
  ["georgian", /\p{Script=Georgian}/u],
  ["armenian", /\p{Script=Armenian}/u],
];

const supportedLanguagesByScript = {
  arabic: ["ar", "fa", "ur"],
  hebrew: ["he"],
  latin: ["cs", "de", "en", "es", "fr", "hu", "id", "it", "ms", "nl", "pl", "pt", "ro", "tr", "vi"],
  cyrillic: ["bg", "kk", "ru", "sr", "uk"],
  greek: ["el"],
  han: ["ja", "zh", "zh-Hans", "zh-Hant"],
  hiragana: ["ja"],
  katakana: ["ja"],
  hangul: ["ko"],
  devanagari: ["hi", "mr", "ne"],
  bengali: ["bn"],
  gurmukhi: ["pa"],
  tamil: ["ta"],
  telugu: ["te"],
  thai: ["th"],
  georgian: ["ka"],
  armenian: ["hy"],
};

function scriptForCharacter(character) {
  for (const [name, matcher] of scriptMatchers) {
    if (matcher.test(character)) return name;
  }
  return null;
}

export function detectSourceScript(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const counts = {};
  let letters = 0;
  for (const character of text) {
    if (!/\p{L}/u.test(character)) continue;
    letters += 1;
    const script = scriptForCharacter(character) || "other";
    counts[script] = (counts[script] || 0) + 1;
  }
  const scripts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const dominantScript = scripts[0] || null;
  const dominantCount = dominantScript ? counts[dominantScript] : 0;
  return {
    dominantScript,
    scripts,
    counts,
    letters,
    mixed: scripts.length > 1,
    confidence: letters ? dominantCount / letters : 0,
    supported: Boolean(dominantScript && supportedLanguagesByScript[dominantScript]),
    candidateLanguages: dominantScript ? supportedLanguagesByScript[dominantScript] || [] : [],
    requiresLanguageMetadata: dominantScript === "arabic" || dominantScript === "han" || scripts.length > 1,
  };
}

export function sourceScriptStatus() {
  return {
    scripts: Object.keys(supportedLanguagesByScript),
    languages: [...new Set(Object.values(supportedLanguagesByScript).flat())].sort(),
    supportedLanguagesByScript,
  };
}
