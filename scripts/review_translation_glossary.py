from __future__ import annotations

import argparse
import json
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

import process_sql_translations as workflow


RULES = (
    (re.compile(r"\bAvenue\b", re.I), re.compile("خیابان"), "Avenue=خیابان"),
    (re.compile(r"\bRue\b", re.I), re.compile("خیابان"), "Rue=خیابان"),
    (re.compile(r"\bBoulevard\b", re.I), re.compile("بلوار"), "Boulevard=بلوار"),
    (re.compile(r"\bImpasse\b", re.I), re.compile("بن‌بست"), "Impasse=بن‌بست"),
    (re.compile(r"(^Stade\b|\b(?:du|de|des) Stade\b)", re.I), re.compile("ورزشگاه"), "Stade=ورزشگاه"),
    (re.compile(r"(^Parking\b|\bParking$)", re.I), re.compile("پارکینگ"), "Parking=پارکینگ"),
    (re.compile(r"(^Gare\b|\bde la Gare\b)", re.I), re.compile("ایستگاه"), "Gare=ایستگاه"),
    (re.compile(r"(^H[oô]pital\b|\bde l['’]H[oô]pital\b)", re.I), re.compile("بیمارستان"), "Hôpital=بیمارستان"),
    (re.compile(r"(^Jardin\b|\bdu Jardin\b|\bde l['’]Jardin\b)", re.I), re.compile("باغ|بوستان"), "Jardin=باغ"),
    (re.compile(r"(^Place\b|\bde la Place\b)", re.I), re.compile("میدان"), "Place=میدان"),
    (re.compile(r"(^Port\s+(?:de|du)\b|\bdu Port\b|\bde Port\b)", re.I), re.compile("بندر"), "Port=بندر"),
    (re.compile(r"(^Pont\b|\bdu Pont\b|\bPont\s)", re.I), re.compile("پل"), "Pont=پل"),
    (re.compile(r"\bPlage\b", re.I), re.compile("ساحل"), "Plage=ساحل"),
    (re.compile(r"(^Chemin\b|\bdu Chemin\b)", re.I), re.compile("مسیر|راه"), "Chemin=مسیر"),
)

CURATED_TRANSLATIONS = {
    ("Avenue Jacques Abba", "transportation_name", "minor"): "خیابان ژاک آبا",
    ("Avenue Hugues Savorani", "transportation_name", "minor"): "خیابان اوگ ساوورانی",
    ("Avenue du 3 Septembre", "transportation_name", "secondary"): "خیابان سوم سپتامبر",
    ("Impasse du Stade", "transportation_name", "service"): "بن‌بست ورزشگاه",
    ("Avenue Marquet", "transportation_name", "minor"): "خیابان مارکه",
    ("Rue de l'Industrie", "transportation_name", "minor"): "خیابان صنعت",
    ("Route de l'Hôpital", "transportation_name", "minor"): "جاده بیمارستان",
    ("Boulevard du Jardin Exotique", "transportation_name", "secondary"): "بلوار باغ اگزوتیک",
    ("Boulevard du Jardin Exotique", "transportation_name", "primary"): "بلوار باغ اگزوتیک",
    ("Pharmacie du Jardin Exotique", "poi", "amenity"): "داروخانه باغ اگزوتیک",
    ("Avenue de Vilaine", "poi", "bus"): "ایستگاه اتوبوس خیابان ویلن",
    ("Avenue de Grande-Bretagne", "transportation_name", "minor"): "خیابان بریتانیای کبیر",
    ("Jardin d'Eau Apartments", "poi", ""): "آپارتمان‌های باغ آب",
    ("Place du Casino", "poi", "bus"): "ایستگاه اتوبوس میدان کازینو",
    ("La Villa Du Pont", "poi", ""): "ویلای پل",
    ("Stade des Moneghetti", "poi", "bus"): "ایستگاه اتوبوس ورزشگاه مونه‌گتی",
    ("Parking du Jardin Exotique", "poi", "amenity"): "پارکینگ باغ اگزوتیک",
    ("Jardin Exotique", "place", "suburb"): "باغ اگزوتیک",
    ("Parking du Jardin Exotique", "transportation_name", "service"): "پارکینگ باغ اگزوتیک",
    ("Le Kiosque de la Place d'Armes", "poi", "shop"): "کیوسک میدان دارم",
    ("Stade Nautique Rainier III", "poi", "swimming"): "ورزشگاه آبی رنیه سوم",
    ("Stade Nautique", "transportation_name", "path"): "مسیر ورزشگاه آبی",
    ("Stade Nautique", "poi", "bus"): "ایستگاه اتوبوس ورزشگاه آبی",
    ("Avenue Albert II", "transportation_name", "secondary"): "خیابان آلبر دوم",
    ("Avenue de Fontvieille", "transportation_name", "primary"): "خیابان فون‌وی‌ی",
    ("Parking de la Colle", "poi", "amenity"): "پارکینگ لا کُل",
    ("Parking du Stade", "poi", "amenity"): "پارکینگ ورزشگاه",
    ("Les Terrasses du Port", "poi", ""): "تراس‌های بندر",
    ("Parking du Chemin des Pêcheurs", "poi", "amenity"): "پارکینگ مسیر ماهیگیران",
    ("Palais de la Plage", "poi", ""): "کاخ ساحل",
    ("Le Méridien • Valet Parking", "transportation_name", "service"): "پارکینگ اختصاصی لو مریدین",
    ("Plage du Pont de Fer", "poi", ""): "ساحل پل آهنی",
}


def issues(source_name: str, translated_name: str) -> list[str]:
    return [label for source, translated, label in RULES
            if source.search(source_name) and not translated.search(translated_name)]


def key_for(fields: list[str]) -> tuple[str, str, str, str] | None:
    properties = workflow.parse_json_copy(fields[4])
    source_name = workflow.clean_name(properties.get("name"))
    if not source_name:
        return None
    layer = fields[3]
    class_name = workflow.clean_name(properties.get("class"))
    key = workflow.stable_hash([source_name, layer, class_name])[:24]
    return key, source_name, layer, class_name


def collect(input_path: Path) -> dict[str, dict[str, str]]:
    flagged: dict[str, dict[str, str]] = {}
    for fields in workflow.iter_copy_fields(input_path):
        identity = key_for(fields)
        if not identity:
            continue
        key, source_name, layer, class_name = identity
        translated_name = workflow.clean_name(workflow.parse_json_copy(fields[5]).get("name"))
        curated = CURATED_TRANSLATIONS.get((source_name, layer, class_name))
        found = issues(source_name, translated_name)
        if curated and curated != translated_name:
            found.append("ترجمهٔ بازبینی‌شده")
        if found:
            flagged[key] = {"key": key, "sourceName": source_name, "layer": layer,
                            "className": class_name, "previous": translated_name, "issues": "، ".join(found),
                            **({"curated": curated} if curated else {})}
    return flagged


def request_batch(endpoint: str, batch: list[dict[str, str]]) -> dict[str, str]:
    payload = {"items": [{name: item[name] for name in ("key", "sourceName", "layer", "className")}
                         for item in batch]}
    request = urllib.request.Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        if error.code == 502 and len(batch) > 1:
            middle = len(batch) // 2
            return request_batch(endpoint, batch[:middle]) | request_batch(endpoint, batch[middle:])
        raise RuntimeError(f"سرویس ترجمه با کد {error.code} پاسخ نامعتبر داد: {detail}") from error
    results = {item["key"]: workflow.clean_name(item.get("translatedName"))
               for item in decoded.get("translations", []) if workflow.clean_name(item.get("translatedName"))}
    if len(results) != len(batch):
        raise RuntimeError("برای همهٔ موارد نیازمند اصلاح، ترجمهٔ معتبر دریافت نشد.")
    for item in batch:
        remaining = issues(item["sourceName"], results[item["key"]])
        if remaining:
            raise RuntimeError(f"ترجمهٔ اصلاحی {item['sourceName']} هنوز با واژه‌نامه سازگار نیست.")
    return results


def rewrite(input_path: Path, output_path: Path, corrections: dict[str, str]) -> int:
    updated = 0
    inside_copy = False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("r", encoding="utf-8", newline="") as source, \
            tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", delete=False,
                                            dir=output_path.parent, suffix=".tmp") as target:
        temporary = Path(target.name)
        for line in source:
            if line.startswith(workflow.COPY_PREFIX):
                inside_copy = True
                target.write(line)
                continue
            if not inside_copy:
                target.write(line)
                continue
            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            raw = line.rstrip("\r\n")
            if raw == r"\.":
                inside_copy = False
                target.write(line)
                continue
            fields = raw.split("\t")
            identity = key_for(fields) if len(fields) == 21 else None
            translated_name = corrections.get(identity[0]) if identity else None
            if not translated_name:
                target.write(line)
                continue
            translation = workflow.parse_json_copy(fields[5])
            translation["name"] = translated_name
            fields[5] = workflow.encode_json_copy(translation)
            target.write("\t".join(fields) + newline)
            updated += 1
    temporary.replace(output_path)
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description="بازبینی واژه‌نامه‌ای ترجمه‌های فایل SQL")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:3005/api/translate-batch")
    parser.add_argument("--batch-size", type=int, default=20)
    args = parser.parse_args()
    flagged = collect(args.input)
    corrections: dict[str, str] = {item["key"]: item["curated"] for item in flagged.values() if item.get("curated")}
    values = [item for item in flagged.values() if not item.get("curated")]
    for start in range(0, len(values), args.batch_size):
        corrections.update(request_batch(args.endpoint, values[start:start + args.batch_size]))
    updated = rewrite(args.input, args.output, corrections)
    print(json.dumps({"flagged_unique_names": len(flagged), "corrected_rows": updated,
                      "output": str(args.output)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
