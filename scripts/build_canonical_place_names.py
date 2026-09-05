from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


LANGUAGES = (
    "ar", "bg", "bn", "cs", "de", "el", "en", "es", "fa", "fr", "he", "hi", "hu", "hy",
    "id", "it", "ja", "ka", "kk", "ko", "mr", "ms", "ne", "nl", "pa", "pl", "pt", "ro",
    "ru", "sr", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh", "zh-Hans", "zh-Hant",
)

CITIES = {
    "Q1490": "Tokyo", "Q956": "Beijing", "Q649": "Moscow", "Q64": "Berlin", "Q90": "Paris",
    "Q84": "London", "Q85": "Cairo", "Q8684": "Seoul", "Q220": "Rome", "Q60": "New York City",
    "Q65": "Los Angeles", "Q406": "Istanbul", "Q1861": "Bangkok", "Q1353": "Delhi",
}

CAPITALS_QUERY = "SELECT DISTINCT ?city WHERE { ?country wdt:P31 wd:Q3624078; wdt:P36 ?city. }"

NATURAL_EARTH_VERSION = "v5.1.2"
NATURAL_EARTH_THEMES = (
    ("admin1", "ne_10m_admin_1_states_provinces.geojson"),
    ("region_point", "ne_10m_geography_regions_points.geojson"),
    ("marine", "ne_10m_geography_marine_polys.geojson"),
    ("waterway", "ne_10m_rivers_lake_centerlines_scale_rank.geojson"),
    ("lake", "ne_10m_lakes.geojson"),
    ("elevation", "ne_10m_geography_regions_elevation_points.geojson"),
    ("region", "ne_10m_geography_regions_polys.geojson"),
)

TARGET_OVERRIDES = {
    "Q5484": "دریای خزر",
}

CACHE_DIRECTORY = Path("work/canonical-place-cache")

CITY_EXTRA_ALIASES = {
    "Q1490": {
        "ar": ("طوكيو", "توكيو"), "de": ("Tokio",), "es": ("Tokio",), "he": ("טוקיו",),
        "ja": ("東京", "東京都"), "ko": ("도쿄", "도쿄도"), "ru": ("Токио",),
        "zh-Hans": ("东京",), "zh-Hant": ("東京",),
    },
    "Q956": {
        "ar": ("بكين",), "de": ("Peking",), "en": ("Peking", "Pekin"), "es": ("Pekín",),
        "fr": ("Pékin",), "he": ("בייג'ינג",), "it": ("Pechino",), "ja": ("北京", "北京市"),
        "ko": ("베이징", "베이징시"), "pt": ("Pequim",), "ru": ("Пекин",), "tr": ("Pekin",),
        "zh-Hans": ("北京", "北京市"), "zh-Hant": ("北京", "北京市"),
    },
}


def fetch_json(url: str) -> dict:
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIRECTORY / f"{hashlib.sha256(url.encode('utf-8')).hexdigest()}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    request = urllib.request.Request(url, headers={"User-Agent": "TranslatorLab/1.0 canonical-place-builder"})
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8")
            cache_path.write_text(text, encoding="utf-8")
            return json.loads(text)
        except (urllib.error.URLError, TimeoutError, ConnectionResetError) as error:
            last_error = error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"مرجع داده پس از چند تلاش در دسترس نبود: {url}") from last_error


def labels_for_language(entity: dict, language: str) -> set[str]:
    keys = {language, language.lower(), language.split("-", 1)[0]}
    values: set[str] = set()
    for key in keys:
        label = entity.get("labels", {}).get(key, {}).get("value")
        if label:
            values.add(label.strip())
    return {value for value in values if value}


def capital_ids() -> list[str]:
    parameters = urllib.parse.urlencode({"query": CAPITALS_QUERY, "format": "json"})
    payload = fetch_json(f"https://query.wikidata.org/sparql?{parameters}")
    ids = {row["city"]["value"].rsplit("/", 1)[-1] for row in payload["results"]["bindings"]}
    return sorted(entity_id for entity_id in ids if re.fullmatch(r"Q\d+", entity_id))


def wikidata_entities(entity_ids: list[str]) -> dict[str, dict]:
    entities: dict[str, dict] = {}
    for offset in range(0, len(entity_ids), 40):
        parameters = urllib.parse.urlencode({
            "action": "wbgetentities", "ids": "|".join(entity_ids[offset:offset + 40]),
            "props": "labels|info|claims", "languages": "|".join(LANGUAGES),
            "format": "json", "formatversion": "2",
        })
        payload = fetch_json(f"https://www.wikidata.org/w/api.php?{parameters}")
        entities.update(payload["entities"])
    return entities


def property_value(properties: dict, name: str) -> str:
    return str(properties.get(name) or properties.get(name.upper()) or "").strip()


def natural_earth_kind(theme: str, properties: dict) -> str:
    feature_class = property_value(properties, "featurecla").casefold()
    cleaned = re.sub(r"[^a-z0-9]+", "_", feature_class).strip("_")
    return "admin1" if theme == "admin1" else cleaned or theme


def geometry_center(geometry: dict) -> list[float] | None:
    coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
    if not isinstance(coordinates, list):
        return None
    if geometry.get("type") == "Point" and len(coordinates) >= 2:
        try:
            point = [float(coordinates[0]), float(coordinates[1])]
            return point if -180 <= point[0] <= 180 and -90 <= point[1] <= 90 else None
        except (TypeError, ValueError):
            return None
    points: list[tuple[float, float]] = []

    def collect(value: object) -> None:
        if isinstance(value, list) and len(value) >= 2 \
                and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            points.append((float(value[0]), float(value[1])))
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(coordinates)
    if not points:
        return None
    west, east = min(point[0] for point in points), max(point[0] for point in points)
    south, north = min(point[1] for point in points), max(point[1] for point in points)
    if east - west > 180:
        return None
    return [round((west + east) / 2, 7), round((south + north) / 2, 7)]


def wikidata_coordinate(entity: dict) -> list[float] | None:
    claims = entity.get("claims", {}).get("P625", [])
    for claim in claims:
        value = claim.get("mainsnak", {}).get("datavalue", {}).get("value", {})
        try:
            point = [float(value["longitude"]), float(value["latitude"])]
        except (KeyError, TypeError, ValueError):
            continue
        if -180 <= point[0] <= 180 and -90 <= point[1] <= 90:
            return point
    return None


def natural_earth_entries() -> tuple[list[dict], dict[str, int]]:
    root = (f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            f"{NATURAL_EARTH_VERSION}/geojson")
    merged: dict[str, dict] = {}
    source_rows: dict[str, int] = {}
    for theme, filename in NATURAL_EARTH_THEMES:
        payload = fetch_json(f"{root}/{filename}")
        source_rows[filename] = len(payload.get("features", []))
        for feature in payload.get("features", []):
            properties = feature.get("properties") or {}
            target_name = property_value(properties, "name_fa")
            english = property_value(properties, "name_en") or property_value(properties, "name")
            if not target_name or not english or "/" in target_name or len(target_name) > 100:
                continue
            kind = natural_earth_kind(theme, properties)
            stable_id = (property_value(properties, "wikidataid")
                         or property_value(properties, "ne_id")
                         or hashlib.sha256(f"{kind}\0{english}".encode("utf-8")).hexdigest()[:20])
            target_name = TARGET_OVERRIDES.get(stable_id, target_name)
            entry_id = f"natural-earth:{stable_id}"
            entry = merged.setdefault(entry_id, {
                "id": entry_id, "kind": kind, "target_name": target_name,
                "aliases": [], "_seen": set(), "_kinds": set(),
            })
            point = geometry_center(feature.get("geometry") or {})
            if point and "coordinates" not in entry:
                entry["coordinates"] = point
            entry["_kinds"].add(kind)
            for language in LANGUAGES:
                field = "name_zht" if language == "zh-Hant" else f"name_{language.split('-', 1)[0]}"
                value = property_value(properties, field)
                marker = (language, value.casefold())
                if value and marker not in entry["_seen"]:
                    entry["_seen"].add(marker)
                    entry["aliases"].append({"language": language, "value": value})
            for value in (english, property_value(properties, "name"), property_value(properties, "name_alt")):
                for alias in (part.strip() for part in re.split(r"[|;]", value) if part.strip()):
                    marker = ("und", alias.casefold())
                    if marker not in entry["_seen"]:
                        entry["_seen"].add(marker)
                        entry["aliases"].append({"language": "und", "value": alias})

    entries = []
    for entry in merged.values():
        entry["kinds"] = sorted(entry.pop("_kinds"))
        entry.pop("_seen")
        if entry["aliases"]:
            entries.append(entry)
    return sorted(entries, key=lambda item: item["id"]), source_rows


def build() -> dict:
    commit = fetch_json("https://api.github.com/repos/unicode-org/cldr-json/commits/main")["sha"]
    cldr_root = f"https://raw.githubusercontent.com/unicode-org/cldr-json/{commit}/cldr-json/cldr-localenames-full/main"
    locale_territories: dict[str, dict[str, str]] = {}
    for language in LANGUAGES:
        payload = fetch_json(f"{cldr_root}/{language}/territories.json")
        main = next(iter(payload["main"].values()))
        locale_territories[language] = main["localeDisplayNames"]["territories"]

    persian = locale_territories["fa"]
    entries: list[dict] = []
    for code in sorted(key for key in persian if re.fullmatch(r"[A-Z]{2}", key)):
        aliases: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for language, territories in locale_territories.items():
            value = territories.get(code, "").strip()
            marker = (language, value.casefold())
            if value and marker not in seen:
                seen.add(marker)
                aliases.append({"language": language, "value": value})
        entries.append({"id": f"country:{code}", "kind": "country", "target_name": persian[code],
                        "aliases": aliases})

    requested_cities = sorted(set(CITIES) | set(capital_ids()))
    wikidata_revisions: dict[str, int] = {}
    for entity_id, entity in wikidata_entities(requested_cities).items():
        expected_english = CITIES.get(entity_id)
        english = entity.get("labels", {}).get("en", {}).get("value")
        if expected_english and english != expected_english:
            raise ValueError(f"Wikidata identity mismatch for {entity_id}: {english!r}")
        target_name = entity.get("labels", {}).get("fa", {}).get("value", "").strip()
        if not target_name:
            continue
        if "/" in target_name:
            if expected_english:
                raise ValueError(f"Persian canonical label needs review for {entity_id}: {target_name!r}")
            continue
        if not english:
            continue
        if expected_english is None and len(target_name) > 80:
            continue
        kind = "city" if entity_id in CITIES else "capital"
        aliases: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for language in LANGUAGES:
            values = labels_for_language(entity, language)
            values.update(CITY_EXTRA_ALIASES.get(entity_id, {}).get(language, ()))
            for value in sorted(values):
                marker = (language, value.casefold())
                if marker not in seen:
                    seen.add(marker)
                    aliases.append({"language": language, "value": value})
        wikidata_revisions[entity_id] = entity.get("lastrevid", 0)
        entry = {"id": f"wikidata:{entity_id}", "kind": kind, "target_name": target_name,
                 "aliases": aliases}
        coordinates = wikidata_coordinate(entity)
        if coordinates:
            entry["coordinates"] = coordinates
        entries.append(entry)

    earth_entries, earth_source_rows = natural_earth_entries()
    entries.extend(earth_entries)

    return {
        "format_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target_language": "fa",
        "languages": list(LANGUAGES),
        "sources": {"cldr_commit": commit, "wikidata_revisions": wikidata_revisions,
                    "capital_query": CAPITALS_QUERY,
                    "natural_earth_version": NATURAL_EARTH_VERSION,
                    "natural_earth_source_rows": earth_source_rows},
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="ساخت حافظهٔ آفلاین نام‌های جغرافیایی معیار")
    parser.add_argument("--output", type=Path,
                        default=Path("server/data/canonical-place-names.mjs"))
    args = parser.parse_args()
    payload = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(f"export default {content};\n", encoding="utf-8")
    aliases = sum(len(entry["aliases"]) for entry in payload["entries"])
    coordinates = sum(1 for entry in payload["entries"] if entry.get("coordinates"))
    print(json.dumps({"entries": len(payload["entries"]), "aliases": aliases, "coordinates": coordinates,
                      "languages": len(payload["languages"]), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
