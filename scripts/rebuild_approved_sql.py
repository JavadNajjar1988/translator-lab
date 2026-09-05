from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from process_sql_translations import COPY_PREFIX, EDIT_KEYS, clean_name, encode_json_copy, parse_json_copy, stable_hash


def rebuild(base_sql: Path, memory_file: Path, output_sql: Path) -> dict[str, object]:
    payload = json.loads(memory_file.read_text(encoding="utf-8"))
    entries = payload.get("entries", [])
    approved = {entry["key"]: entry for entry in entries if entry.get("approval_status") == "client_approved"}

    stats: dict[str, object] = {
        "rows": 0,
        "named_rows": 0,
        "updated_rows": 0,
        "missing_keys": [],
    }
    inside_copy = False
    temporary = output_sql.with_suffix(output_sql.suffix + ".tmp")
    output_sql.parent.mkdir(parents=True, exist_ok=True)

    with base_sql.open("r", encoding="utf-8", newline="") as source, temporary.open(
        "w", encoding="utf-8", newline=""
    ) as target:
        for line in source:
            if line.startswith(COPY_PREFIX):
                inside_copy = True
                target.write(line)
                continue
            if inside_copy and line.rstrip("\r\n") == r"\.":
                inside_copy = False
                target.write(line)
                continue
            if not inside_copy:
                target.write(line)
                continue

            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            fields = line.rstrip("\r\n").split("\t")
            stats["rows"] = int(stats["rows"]) + 1
            if len(fields) != 21:
                target.write(line)
                continue

            properties = parse_json_copy(fields[4])
            source_name = clean_name(properties.get("name"))
            if not source_name:
                target.write(line)
                continue

            stats["named_rows"] = int(stats["named_rows"]) + 1
            layer = fields[3]
            class_name = clean_name(properties.get("class"))
            key = stable_hash(["fr", source_name, layer, class_name, "fa"])[:24]
            entry = approved.get(key)
            if not entry:
                missing = stats["missing_keys"]
                assert isinstance(missing, list)
                missing.append({"key": key, "source_name": source_name, "layer": layer, "class": class_name})
                target.write(line)
                continue

            translation = parse_json_copy(fields[5])
            for edit_key in EDIT_KEYS:
                properties.pop(edit_key, None)
                translation.pop(edit_key, None)
            translation["name"] = clean_name(entry.get("translated_name"))
            fields[4] = encode_json_copy(properties)
            fields[5] = encode_json_copy(translation)
            target.write("\t".join(fields) + newline)
            stats["updated_rows"] = int(stats["updated_rows"]) + 1

    if stats["missing_keys"]:
        temporary.unlink(missing_ok=True)
        raise SystemExit(json.dumps(stats, ensure_ascii=False, indent=2))

    temporary.replace(output_sql)
    stats["sha256"] = hashlib.sha256(output_sql.read_bytes()).hexdigest().upper()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="بازسازی فایل SQL از حافظه ترجمه تاییدشده")
    parser.add_argument("base_sql", type=Path)
    parser.add_argument("memory_file", type=Path)
    parser.add_argument("output_sql", type=Path)
    args = parser.parse_args()
    print(json.dumps(rebuild(args.base_sql, args.memory_file, args.output_sql), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
