from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from process_sql_translations import clean_name, iter_copy_fields, parse_json_copy, stable_hash


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


FORMAT_VERSION = 1


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def collect_approved_entries(input_path: Path, source_language: str, target_language: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    entries_by_key: dict[str, dict[str, Any]] = {}
    layers: Counter[str] = Counter()
    stats: dict[str, Any] = {
        "total_rows": 0,
        "rows_without_source_name": 0,
        "named_rows": 0,
        "translated_rows": 0,
        "missing_translation_rows": 0,
        "duplicate_rows": 0,
        "conflicts": [],
    }

    for fields in iter_copy_fields(input_path):
        stats["total_rows"] += 1
        properties = parse_json_copy(fields[4])
        translation = parse_json_copy(fields[5])
        source_name = clean_name(properties.get("name"))
        if not source_name:
            stats["rows_without_source_name"] += 1
            continue

        stats["named_rows"] += 1
        translated_name = clean_name(translation.get("name"))
        if not translated_name:
            stats["missing_translation_rows"] += 1
            continue

        stats["translated_rows"] += 1
        layer = fields[3]
        class_name = clean_name(properties.get("class"))
        identity = [source_language, source_name, layer, class_name, target_language]
        key = stable_hash(identity)[:24]
        entry = {
            "key": key,
            "source_language": source_language,
            "source_name": source_name,
            "layer": layer,
            "class": class_name,
            "target_language": target_language,
            "translated_name": translated_name,
            "approval_status": "client_approved",
        }
        previous = entries_by_key.get(key)
        if previous:
            stats["duplicate_rows"] += 1
            if previous["translated_name"] != translated_name:
                stats["conflicts"].append({
                    "key": key,
                    "source_name": source_name,
                    "layer": layer,
                    "class": class_name,
                    "translations": sorted({previous["translated_name"], translated_name}),
                })
            continue
        entries_by_key[key] = entry
        layers[layer] += 1

    entries = sorted(entries_by_key.values(), key=lambda item: (item["layer"], item["source_name"], item["class"]))
    stats["unique_entries"] = len(entries)
    stats["layers"] = dict(sorted(layers.items()))
    return entries, stats


def stratified_evaluation(entries: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or limit >= len(entries):
        chosen = entries
    else:
        by_layer: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
        for entry in sorted(entries, key=lambda item: item["key"]):
            by_layer[entry["layer"]].append(entry)
        chosen = []
        layer_names = sorted(by_layer)
        while len(chosen) < limit and layer_names:
            remaining_layers: list[str] = []
            for layer in layer_names:
                if len(chosen) >= limit:
                    break
                queue = by_layer[layer]
                if queue:
                    chosen.append(queue.popleft())
                if queue:
                    remaining_layers.append(layer)
            layer_names = remaining_layers

    return [{
        "key": entry["key"],
        "source_name": entry["source_name"],
        "layer": entry["layer"],
        "class": entry["class"],
        "expected_translation": entry["translated_name"],
    } for entry in chosen]


def write_assets(
    input_path: Path,
    output_directory: Path,
    source_language: str = "fr",
    target_language: str = "fa",
    evaluation_limit: int = 500,
    approved_at: str | None = None,
) -> dict[str, Any]:
    entries, stats = collect_approved_entries(input_path, source_language, target_language)
    if stats["missing_translation_rows"]:
        raise ValueError(f"{stats['missing_translation_rows']} ردیف نام‌دار فاقد ترجمه است.")
    if stats["conflicts"]:
        raise ValueError(f"{len(stats['conflicts'])} تعارض ترجمه برای کلیدهای یکسان پیدا شد.")
    if not entries:
        raise ValueError("هیچ ترجمهٔ تأییدشده‌ای در فایل پیدا نشد.")

    generated_at = datetime.now(timezone.utc).isoformat()
    manifest = {
        "format_version": FORMAT_VERSION,
        "source_file": input_path.name,
        "source_sha256": file_sha256(input_path),
        "source_language": source_language,
        "target_language": target_language,
        "approval_status": "client_approved",
        "approved_at": approved_at,
        "generated_at": generated_at,
        "stats": stats,
        "files": {
            "translation_memory": "translation-memory.json",
            "evaluation_set": "evaluation-set.json",
        },
    }
    memory = {
        "format_version": FORMAT_VERSION,
        "source_sha256": manifest["source_sha256"],
        "generated_at": generated_at,
        "entries": entries,
    }
    evaluation_entries = stratified_evaluation(entries, evaluation_limit)
    evaluation = {
        "format_version": FORMAT_VERSION,
        "source_sha256": manifest["source_sha256"],
        "generated_at": generated_at,
        "selection": "deterministic_layer_round_robin",
        "entry_count": len(evaluation_entries),
        "entries": evaluation_entries,
    }

    output_directory.mkdir(parents=True, exist_ok=True)
    (output_directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_directory / "translation-memory.json").write_text(json.dumps(memory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_directory / "evaluation-set.json").write_text(json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="ساخت حافظه ترجمه و مجموعه ارزیابی از فایل تأییدشده کارفرما")
    parser.add_argument("input", type=Path, help="فایل کامل SQL تأییدشده")
    parser.add_argument("--output", type=Path, default=Path("work/approved-translations"), help="پوشه خروجی محلی")
    parser.add_argument("--source-language", default="fr")
    parser.add_argument("--target-language", default="fa")
    parser.add_argument("--evaluation-limit", type=int, default=500)
    parser.add_argument("--approved-at", help="تاریخ تأیید کارفرما با قالب YYYY-MM-DD")
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"فایل ورودی پیدا نشد: {args.input}")
    try:
        manifest = write_assets(
            args.input,
            args.output,
            args.source_language,
            args.target_language,
            args.evaluation_limit,
            args.approved_at,
        )
    except ValueError as error:
        raise SystemExit(f"فایل تأییدشده معتبر نیست: {error}") from error
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
