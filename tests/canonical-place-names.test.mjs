import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPlaceNames, coordinateResolutionPolicy,
  createCanonicalPlaceNames } from "../server/canonical-place-names.mjs";

test("canonical place memory resolves exonyms across common map languages", () => {
  const items = [
    { key: "de", sourceName: "Deutschland", layer: "place", className: "country" },
    { key: "ar", sourceName: "ألمانيا", layer: "place", className: "country" },
    { key: "zh", sourceName: "德国", layer: "place", className: "country" },
    { key: "tokyo", sourceName: "東京", layer: "place", className: "city" },
    { key: "beijing", sourceName: "Beijing", layer: "place", className: "city" },
    { key: "peking", sourceName: "Peking", layer: "", className: "" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.deepEqual(items.map((item) => hits.get(item.key)?.translatedName),
    ["آلمان", "آلمان", "آلمان", "توکیو", "پکن", "پکن"]);
  assert.ok([...hits.values()].every((item) => item.provider === "canonical-place-memory"));
});

test("canonical identifiers also resolve Natural Earth entries carrying Wikidata ids", () => {
  const hit = canonicalPlaceNames.resolve([{ key: "monaco-ville", sourceName: "changed upstream name",
    layer: "place", className: "suburb", wikidataId: "Q55115" }]).get("monaco-ville");
  assert.equal(hit?.translatedName, "موناکوویل");
  assert.equal(hit?.canonicalId, "natural-earth:Q55115");
  assert.equal(hit?.provider, "canonical-place-identifier");
});

test("verified Persian Wikidata identity supplements resolve Monaco districts offline", () => {
  const items = [
    { key: "monte-carlo", sourceName: "unknown", layer: "place", className: "suburb", wikidataId: "Q45240" },
    { key: "condamine", sourceName: "unknown", layer: "place", className: "suburb", wikidataId: "Q55095" },
    { key: "fontvieille", sourceName: "unknown", layer: "place", className: "suburb", wikidataId: "Q55098" },
    { key: "moneghetti", sourceName: "unknown", layer: "place", className: "suburb", wikidataId: "Q55108" },
    { key: "monaco-country", sourceName: "unknown", layer: "place", className: "country", wikidataId: "Q235" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.deepEqual(items.map((item) => hits.get(item.key)?.translatedName),
    ["مونت‌کارلو", "لا کوندامین", "فونوی", "له مونگتی", "موناکو"]);
  assert.ok([...hits.values()].every((hit) => hit.provider === "canonical-place-identifier"));
  assert.equal(canonicalPlaceNames.status().identitySupplementEntries, 4);
});

test("canonical place memory avoids ambiguous aliases and non-geographic shop names", () => {
  const ambiguous = createCanonicalPlaceNames({ target_language: "fa", generated_at: "test", languages: ["en"], entries: [
    { id: "country:A", target_name: "الف", aliases: [{ language: "en", value: "Same" }] },
    { id: "country:B", target_name: "ب", aliases: [{ language: "en", value: "Same" }] },
  ] });
  assert.equal(ambiguous.resolve([{ key: "same", sourceName: "Same", layer: "place", className: "country" }]).size, 0);
  assert.equal(canonicalPlaceNames.resolve([
    { key: "shop", sourceName: "Jordan", layer: "poi", className: "clothing_store" },
  ]).size, 0);
});

test("an ambiguous exact name cannot fall through to composite translation", () => {
  const ambiguous = createCanonicalPlaceNames({ target_language: "fa", generated_at: "test", languages: ["en"], entries: [
    { id: "lake:A", kind: "lake", target_name: "دریاچه الف", aliases: [{ language: "en", value: "Lake Same" }] },
    { id: "lake:B", kind: "lake", target_name: "دریاچه ب", aliases: [{ language: "en", value: "Lake Same" }] },
    { id: "city:SAME", kind: "city", target_name: "سیم", aliases: [{ language: "en", value: "Same" }] },
  ] });
  assert.equal(ambiguous.resolve([
    { key: "ambiguous", sourceName: "Lake Same", layer: "water_name", className: "lake" },
  ]).size, 0);
});

test("canonical place memory translates controlled map concepts around known place names", () => {
  const items = [
    { key: "en", sourceName: "Tokyo Station", layer: "transportation_name", className: "station" },
    { key: "de", sourceName: "Bahnhof Berlin", layer: "transportation_name", className: "station" },
    { key: "fr", sourceName: "Gare de Paris", layer: "transportation_name", className: "station" },
    { key: "ar", sourceName: "محطة القاهرة", layer: "transportation_name", className: "station" },
    { key: "ja", sourceName: "東京駅", layer: "transportation_name", className: "station" },
    { key: "zh", sourceName: "北京国际机场", layer: "poi", className: "airport" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.deepEqual(items.map((item) => hits.get(item.key)?.translatedName), [
    "ایستگاه توکیو", "ایستگاه برلین", "ایستگاه پاریس", "ایستگاه قاهره", "ایستگاه توکیو",
    "فرودگاه بین‌المللی پکن",
  ]);
  assert.ok([...hits.values()].every((item) => item.provider === "canonical-place-composite"));
});

test("canonical place memory resolves administrative and physical map names without the model", () => {
  const items = [
    { key: "california", sourceName: "California", layer: "place", className: "state" },
    { key: "bavaria", sourceName: "Bayern", layer: "place", className: "state" },
    { key: "caspian", sourceName: "Caspian Sea", layer: "water_name", className: "sea" },
    { key: "persian-gulf", sourceName: "الخليج العربي", layer: "water_name", className: "gulf" },
    { key: "nile", sourceName: "Nile", layer: "water_name", className: "river" },
    { key: "alps", sourceName: "Alpen", layer: "natural", className: "mountain_range" },
    { key: "baikal", sourceName: "Lake Baikal", layer: "water_name", className: "lake" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.deepEqual(items.map((item) => hits.get(item.key)?.translatedName), [
    "کالیفرنیا", "بایرن", "دریای خزر", "خلیج فارس", "رود نیل", "رشته‌کوه آلپ", "دریاچه بایکال",
  ]);
});

test("canonical context distinguishes a country from a same-named state", () => {
  const hits = canonicalPlaceNames.resolve([
    { key: "country", sourceName: "Georgia", layer: "place", className: "country" },
    { key: "state", sourceName: "Georgia", layer: "place", className: "state" },
  ]);
  assert.equal(hits.get("country")?.translatedName, "گرجستان");
  assert.equal(hits.get("state")?.translatedName, "جورجیا");
});

test("canonical context rejects a single alias from the wrong geographic kind", () => {
  const source = createCanonicalPlaceNames({ target_language: "fa", generated_at: "test", languages: ["en"], entries: [
    { id: "admin1:A", kind: "admin1", target_name: "استان نمونه", aliases: [{ language: "en", value: "Sample" }] },
  ] });
  assert.equal(source.resolve([
    { key: "city", sourceName: "Sample", layer: "place", className: "city" },
  ]).size, 0);
  assert.equal(source.resolve([
    { key: "state", sourceName: "Sample", layer: "place", className: "state" },
  ]).get("state")?.translatedName, "استان نمونه");
});

test("canonical composite matching does not reinterpret a shop name", () => {
  assert.equal(canonicalPlaceNames.resolve([
    { key: "shop", sourceName: "Tokyo Station", layer: "poi", className: "shop" },
  ]).size, 0);
});

test("canonical place dataset exposes offline coverage status", () => {
  const status = canonicalPlaceNames.status();
  assert.equal(status.loaded, true);
  assert.ok(status.entries >= 8900);
  assert.equal(status.languages, 40);
  assert.ok(status.aliases > 157000);
  assert.equal(status.compositeRules, 17);
  assert.equal(status.naturalEarthVersion, "v5.1.2");
  assert.ok(status.kinds.admin1 > 4500);
  assert.ok(status.kinds.river > 1000);
  assert.equal(status.supplementalAliases, 5);
  assert.equal(status.coordinates, 9029);
  assert.equal(status.coordinateResolvableAliases, 5196);
  assert.equal(status.coordinateEvaluation.cases, 11613);
  assert.equal(status.coordinateEvaluation.runs["25"].wrong, 0);
  assert.equal(status.coordinateEvaluation.midpoint.unsafe, 0);
});

test("canonical supplements cover acceptance gaps without editing the generated source", () => {
  const items = [
    { key: "ar", sourceName: "جبال الألب", layer: "natural", className: "mountain_range" },
    { key: "he", sourceName: "הנילוס", layer: "water_name", className: "river" },
    { key: "zh", sourceName: "里海", layer: "water_name", className: "sea" },
    { key: "ru", sourceName: "Эверест", layer: "natural", className: "mountain" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.deepEqual(items.map((item) => hits.get(item.key)?.translatedName),
    ["رشته‌کوه آلپ", "رود نیل", "دریای خزر", "کوه اورست"]);
});

test("Wikidata gazetteer resolves multilingual city aliases before the model", () => {
  const items = [
    { key: "ar", sourceName: "غويغوي", layer: "place", className: "city" },
    { key: "zh", sourceName: "圭圭", layer: "place", className: "city" },
  ];
  const hits = canonicalPlaceNames.resolve(items);
  assert.equal(hits.get("ar")?.translatedName, "گویگه");
  assert.equal(hits.get("zh")?.translatedName, "گویگه");
  assert.equal(hits.get("zh")?.canonicalId, "wikidata:Q1000143");
  const status = canonicalPlaceNames.status();
  assert.equal(status.wikidataGazetteerEntries, 343);
  assert.equal(status.wikidataGazetteerAliases, 1557);
  assert.equal(status.wikidataGazetteerExcludedAmbiguous, 43);
  assert.equal(status.wikidataGazetteerCoordinates, 343);
});

test("externally proven ambiguous aliases fail closed without a geographic identifier", () => {
  const hits = canonicalPlaceNames.resolve([
    { key: "santiago", sourceName: "圣地亚哥", layer: "place", className: "city" },
  ]);
  assert.equal(hits.has("santiago"), false);
  assert.equal(canonicalPlaceNames.status().blockedAliases, 1);
});

test("a Wikidata identifier resolves a place without guessing from its label", () => {
  const hits = canonicalPlaceNames.resolve([
    { key: "identified", sourceName: "نام ناشناخته", layer: "place", className: "city", wikidataId: "Q172" },
  ]);
  assert.equal(hits.get("identified")?.translatedName, "تورنتو");
  assert.equal(hits.get("identified")?.provider, "canonical-place-identifier");
  assert.equal(canonicalPlaceNames.resolve([
    { key: "wrong-kind", sourceName: "نام ناشناخته", layer: "place", className: "country", wikidataId: "Q172" },
  ]).has("wrong-kind"), false);
});

test("coordinates resolve an ambiguous alias only when the nearest candidate is safely separated", () => {
  const source = createCanonicalPlaceNames({ target_language: "fa", generated_at: "test", languages: ["en"], entries: [
    { id: "wikidata:Q1", kind: "city", target_name: "شهر الف", coordinates: [10, 10],
      aliases: [{ language: "en", value: "Springfield" }] },
    { id: "wikidata:Q2", kind: "city", target_name: "شهر ب", coordinates: [40, 40],
      aliases: [{ language: "en", value: "Springfield" }] },
  ] });
  const hits = source.resolve([
    { key: "near", sourceName: "Springfield", layer: "place", className: "city", longitude: 10.01, latitude: 10.01 },
    { key: "far", sourceName: "Springfield", layer: "place", className: "city", longitude: 25, latitude: 25 },
  ]);
  assert.equal(hits.get("near")?.translatedName, "شهر الف");
  assert.equal(hits.get("near")?.provider, "canonical-place-coordinate");
  assert.equal(hits.has("far"), false);
});

test("the production gazetteer separates an actual same-named city by map position", () => {
  const hit = canonicalPlaceNames.resolve([
    { key: "la-paz", sourceName: "ラパス", layer: "place", className: "city",
      longitude: -68.15, latitude: -16.5 },
  ]).get("la-paz");
  assert.equal(hit?.translatedName, "لاپاز");
  assert.equal(hit?.canonicalId, "wikidata:Q1491");
  assert.equal(hit?.provider, "canonical-place-coordinate");
});

test("the spatial safety gap rejects a nearby but insufficiently separated candidate", () => {
  assert.equal(coordinateResolutionPolicy.minimumGapKilometers, 25);
  const source = createCanonicalPlaceNames({ target_language: "fa", generated_at: "test", languages: ["en"], entries: [
    { id: "wikidata:Q1", kind: "city", target_name: "شهر الف", coordinates: [0, 0],
      aliases: [{ language: "en", value: "Close Name" }] },
    { id: "wikidata:Q2", kind: "city", target_name: "شهر ب", coordinates: [0.3, 0],
      aliases: [{ language: "en", value: "Close Name" }] },
  ] });
  assert.equal(source.resolve([{ key: "uncertain", sourceName: "Close Name", layer: "place",
    longitude: 0.2, latitude: 0 }]).has("uncertain"), false);
});
