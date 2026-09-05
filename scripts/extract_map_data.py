from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path


WEB_MERCATOR_LIMIT = 20037508.342789244


def mercator_to_lon_lat(x: float, y: float) -> list[float]:
    lon = x / WEB_MERCATOR_LIMIT * 180.0
    lat = math.degrees(2.0 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2.0)
    return [round(lon, 7), round(lat, 7)]


def parse_ewkb(raw_hex: str) -> dict:
    data = bytes.fromhex(raw_hex)

    def parse(offset: int) -> tuple[dict, int]:
        byte_order = data[offset]
        offset += 1
        endian = "<" if byte_order == 1 else ">"
        type_code = struct.unpack_from(endian + "I", data, offset)[0]
        offset += 4

        has_z = bool(type_code & 0x80000000)
        has_m = bool(type_code & 0x40000000)
        has_srid = bool(type_code & 0x20000000)
        geometry_type = type_code & 0xFF

        if geometry_type >= 1000:
            dimensions_code, geometry_type = divmod(geometry_type, 1000)
            has_z = dimensions_code in (1, 3)
            has_m = dimensions_code in (2, 3)

        if has_srid:
            offset += 4

        dimensions = 2 + int(has_z) + int(has_m)

        def read_point() -> list[float]:
            nonlocal offset
            values = struct.unpack_from(endian + "d" * dimensions, data, offset)
            offset += 8 * dimensions
            return mercator_to_lon_lat(values[0], values[1])

        def read_count() -> int:
            nonlocal offset
            count = struct.unpack_from(endian + "I", data, offset)[0]
            offset += 4
            return count

        if geometry_type == 1:
            return {"type": "Point", "coordinates": read_point()}, offset

        if geometry_type == 2:
            return {
                "type": "LineString",
                "coordinates": [read_point() for _ in range(read_count())],
            }, offset

        if geometry_type == 3:
            rings = []
            for _ in range(read_count()):
                rings.append([read_point() for _ in range(read_count())])
            return {"type": "Polygon", "coordinates": rings}, offset

        collection_names = {
            4: "MultiPoint",
            5: "MultiLineString",
            6: "MultiPolygon",
            7: "GeometryCollection",
        }
        if geometry_type in collection_names:
            children = []
            for _ in range(read_count()):
                child, offset = parse(offset)
                children.append(child)
            name = collection_names[geometry_type]
            if name == "GeometryCollection":
                return {"type": name, "geometries": children}, offset
            return {
                "type": name,
                "coordinates": [child["coordinates"] for child in children],
            }, offset

        raise ValueError(f"Unsupported EWKB geometry type: {geometry_type}")

    geometry, _ = parse(0)
    return geometry


def iter_copy_rows(sql_path: Path):
    inside_copy = False
    with sql_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("COPY public.geoms "):
                inside_copy = True
                continue
            if not inside_copy:
                continue
            if line.rstrip("\r\n") == r"\.":
                break
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) != 21:
                continue
            yield fields


def json_value(raw: str):
    if raw == r"\N":
        return None
    # PostgreSQL COPY text doubles backslashes. Restore the JSON escaping
    # before handing the value to the JSON decoder.
    return json.loads(raw.replace(r"\\", "\\"))


def edit_requested(properties: dict, translation: dict) -> bool:
    truthy_strings = {"1", "true", "yes", "edit", "edited", "required", "pending"}
    keys = ("edit", "edited", "needs_edit", "translation_edit")
    for container in (translation, properties):
        for key in keys:
            value = container.get(key)
            if value is True or value == 1:
                return True
            if isinstance(value, str) and value.strip().lower() in truthy_strings:
                return True
    return False


def build_feature(fields: list[str]) -> dict:
    osm_type, osm_id, geom_hex, layer, properties_raw, translate_raw = fields[:6]
    properties = json_value(properties_raw) or {}
    translation = json_value(translate_raw) or {}
    source_name = properties.get("name")
    source_name = source_name.strip() if isinstance(source_name, str) else ""
    translated_name = translation.get("name")
    translated_name = translated_name.strip() if isinstance(translated_name, str) else ""
    needs_edit = edit_requested(properties, translation)

    if not source_name:
        status = "no_source"
    elif needs_edit:
        status = "stale"
    elif translated_name:
        status = "translated"
    else:
        status = "pending"

    return {
        "type": "Feature",
        "id": f"{osm_type}-{osm_id}-{layer}",
        "geometry": parse_ewkb(geom_hex),
        "properties": {
            "osm_type": osm_type,
            "osm_id": osm_id,
            "layer": layer,
            "source_name": source_name,
            "translated_name": translated_name,
            "status": status,
            "edit_requested": needs_edit,
            "class": properties.get("class", ""),
            "subclass": properties.get("subclass", ""),
        },
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract_map_data.py INPUT.sql OUTPUT.json")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    features = []
    stats = {"total": 0, "named": 0, "translated": 0, "pending": 0, "no_source": 0, "stale": 0}
    layers: dict[str, int] = {}

    for fields in iter_copy_rows(input_path):
        feature = build_feature(fields)
        features.append(feature)
        stats["total"] += 1
        status = feature["properties"]["status"]
        stats[status] += 1
        if feature["properties"]["source_name"]:
            stats["named"] += 1
        layer = feature["properties"]["layer"]
        layers[layer] = layers.get(layer, 0) + 1

    payload = {
        "type": "FeatureCollection",
        "meta": {
            "source": input_path.name,
            "stats": stats,
            "layers": dict(sorted(layers.items(), key=lambda item: (-item[1], item[0]))),
        },
        "features": features,
    }
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps(payload["meta"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
