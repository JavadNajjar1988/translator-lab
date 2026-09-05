export default Object.freeze({
  source: "https://www.wikidata.org/w/api.php?action=wbgetentities",
  fetchedAt: "2026-09-05T04:55:00.000Z",
  targetLanguage: "fa",
  entries: Object.freeze([
    { id: "wikidata:Q45240", kind: "suburb", target_name: "مونت‌کارلو",
      aliases: [
        { language: "fa", value: "مونت‌کارلو" }, { language: "fa", value: "مونت کارلو" },
        { language: "fa", value: "مونته کارلو" }, { language: "en", value: "Monte Carlo" },
        { language: "fr", value: "Monte-Carlo" },
      ], coordinates: [7.426, 43.739] },
    { id: "wikidata:Q55095", kind: "suburb", target_name: "لا کوندامین",
      aliases: [
        { language: "fa", value: "لا کوندامین" }, { language: "en", value: "La Condamine" },
        { language: "fr", value: "La Condamine" },
      ], coordinates: [7.421, 43.734] },
    { id: "wikidata:Q55098", kind: "suburb", target_name: "فونوی",
      aliases: [
        { language: "fa", value: "فونوی" }, { language: "en", value: "Fontvieille" },
        { language: "fr", value: "Fontvieille" },
      ], coordinates: [7.415, 43.729] },
    { id: "wikidata:Q55108", kind: "suburb", target_name: "له مونگتی",
      aliases: [
        { language: "fa", value: "له مونگتی" }, { language: "en", value: "Moneghetti" },
        { language: "en", value: "Les Moneghetti" }, { language: "fr", value: "Moneghetti" },
        { language: "fr", value: "Les Moneghetti" },
      ], coordinates: [7.416, 43.737] },
  ]),
  overrides: Object.freeze({
    "wikidata:Q235": Object.freeze({ kinds: Object.freeze(["country", "capital", "city"]) }),
  }),
});
