from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


COPY_PREFIX = "COPY public.geoms "
EDIT_KEYS = ("edit", "edited", "needs_edit", "translation_edit")
TRANSLATION_INSTRUCTIONS = (
    "نام عوارض نقشه را به فارسی معیار برگردان. نام خاص را آوانویسی کن، اما واژه‌های عمومی فرانسوی را حتما ترجمه کن: "
    "Avenue و Rue برابر خیابان، Boulevard برابر بلوار، Impasse برابر بن‌بست، Stade برابر ورزشگاه، Parking برابر پارکینگ، "
    "Gare برابر ایستگاه، Hôpital برابر بیمارستان، Jardin برابر باغ، Port برابر بندر، Pont برابر پل، Place برابر میدان، "
    "Plage برابر ساحل و Chemin برابر مسیر است. حرف اضافه و تعریف فرانسوی مانند du و de و des را آوانویسی نکن. "
    "بافت لایه و کلاس را در نظر بگیر و هر کلید را دقیقا یک بار برگردان."
)
TRUTHY_STRINGS = {"1", "true", "yes", "edit", "edited", "required", "pending"}


@dataclass
class Candidate:
    key: str
    source_name: str
    layer: str
    class_name: str
    fingerprint: str
    force: bool


def parse_json_copy(raw: str) -> dict[str, Any]:
    if raw == r"\N":
        return {}
    value = json.loads(raw.replace(r"\\", "\\"))
    return value if isinstance(value, dict) else {}


def encode_json_copy(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return raw.replace("\\", "\\\\")


def flag_is_true(value: Any) -> bool:
    if value is True or value == 1:
        return True
    return isinstance(value, str) and value.strip().lower() in TRUTHY_STRINGS


def has_edit_flag(properties: dict[str, Any], translation: dict[str, Any]) -> bool:
    return any(flag_is_true(container.get(key)) for container in (translation, properties) for key in EDIT_KEYS)


def clean_name(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def stable_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def candidate_from_fields(fields: list[str]) -> Candidate | None:
    if len(fields) != 21:
        return None
    properties = parse_json_copy(fields[4])
    translation = parse_json_copy(fields[5])
    source_name = clean_name(properties.get("name"))
    translated_name = clean_name(translation.get("name"))
    force = has_edit_flag(properties, translation)
    if not source_name or (translated_name and not force):
        return None
    layer = fields[3]
    class_name = clean_name(properties.get("class"))
    key = stable_hash([source_name, layer, class_name])[:24]
    fingerprint = stable_hash([source_name, layer, class_name, translated_name, force])
    return Candidate(key, source_name, layer, class_name, fingerprint, force)


def iter_copy_fields(input_path: Path):
    inside_copy = False
    with input_path.open("r", encoding="utf-8", newline="") as handle:
        for line in handle:
            if line.startswith(COPY_PREFIX):
                inside_copy = True
                continue
            if not inside_copy:
                continue
            if line.rstrip("\r\n") == r"\.":
                break
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) == 21:
                yield fields


def scan_file(input_path: Path) -> tuple[dict[str, Candidate], dict[str, int]]:
    candidates: dict[str, Candidate] = {}
    stats = {"total": 0, "no_source": 0, "translated": 0, "new": 0, "retranslate": 0}
    for fields in iter_copy_fields(input_path):
        stats["total"] += 1
        properties = parse_json_copy(fields[4])
        translation = parse_json_copy(fields[5])
        source_name = clean_name(properties.get("name"))
        translated_name = clean_name(translation.get("name"))
        force = has_edit_flag(properties, translation)
        if not source_name:
            stats["no_source"] += 1
            continue
        if translated_name and not force:
            stats["translated"] += 1
            continue
        stats["retranslate" if force else "new"] += 1
        candidate = candidate_from_fields(fields)
        if not candidate:
            continue
        previous = candidates.get(candidate.key)
        if previous is None or (candidate.force and not previous.force):
            candidates[candidate.key] = candidate
    stats["unique_candidates"] = len(candidates)
    return candidates, stats


def load_cache(cache_path: Path) -> dict[str, dict[str, Any]]:
    if not cache_path.exists():
        return {}
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        entries = payload.get("entries", {}) if isinstance(payload, dict) else {}
        return entries if isinstance(entries, dict) else {}
    except (OSError, json.JSONDecodeError):
        raise SystemExit(f"فایل حافظهٔ ترجمه معتبر نیست: {cache_path}")


def save_cache(cache_path: Path, entries: dict[str, dict[str, Any]]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "updated_at": datetime.now(timezone.utc).isoformat(), "entries": entries}
    temporary = cache_path.with_suffix(cache_path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(cache_path)


def cached_translation(candidate: Candidate, cache: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    entry = cache.get(candidate.key)
    if not isinstance(entry, dict) or not clean_name(entry.get("translated_name")):
        return None
    if candidate.force and entry.get("fingerprint") != candidate.fingerprint:
        return None
    return entry


def extract_output_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"]
    return ""


def request_openai_batch(batch: list[Candidate], api_key: str, model: str) -> dict[str, dict[str, str]]:
    items = [{"key": item.key, "source_name": item.source_name, "layer": item.layer, "class": item.class_name} for item in batch]
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "translations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "key": {"type": "string"},
                        "translated_name": {"type": "string"},
                        "strategy": {"type": "string", "enum": ["translation", "transliteration", "mixed"]},
                    },
                    "required": ["key", "translated_name", "strategy"],
                },
            }
        },
        "required": ["translations"],
    }
    body = {
        "model": model,
        "store": False,
        "instructions": TRANSLATION_INSTRUCTIONS,
        "input": json.dumps({"target_language": "fa", "items": items}, ensure_ascii=False),
        "text": {"format": {"type": "json_schema", "name": "map_name_translation_batch", "strict": True, "schema": schema}},
        "max_output_tokens": max(600, len(batch) * 90),
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"پاسخ نامعتبر سرویس ترجمه با کد {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"اتصال به سرویس ترجمه برقرار نشد: {error.reason}") from error

    output_text = extract_output_text(payload)
    if not output_text:
        raise RuntimeError("خروجی متنی سرویس ترجمه خالی بود.")
    decoded = json.loads(output_text)
    expected = {item.key for item in batch}
    results: dict[str, dict[str, str]] = {}
    for item in decoded.get("translations", []):
        key = item.get("key")
        translated_name = clean_name(item.get("translated_name"))
        if key in expected and translated_name:
            results[key] = {"translated_name": translated_name, "strategy": item.get("strategy", "mixed")}
    missing = expected - results.keys()
    if missing:
        raise RuntimeError(f"سرویس ترجمه برای {len(missing)} نام خروجی معتبر برنگرداند.")
    return results


def request_gemini_batch(batch: list[Candidate], api_key: str, model: str) -> dict[str, dict[str, str]]:
    items = [{"key": item.key, "source_name": item.source_name, "layer": item.layer, "class": item.class_name} for item in batch]
    schema = {
        "type": "object", "additionalProperties": False,
        "properties": {"translations": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "key": {"type": "string"}, "translated_name": {"type": "string"},
                "strategy": {"type": "string", "enum": ["translation", "transliteration", "mixed"]},
            }, "required": ["key", "translated_name", "strategy"],
        }}}, "required": ["translations"],
    }
    prompt = {
        "target_language": "fa", "items": items,
        "instruction": TRANSLATION_INSTRUCTIONS,
    }
    body = {
        "systemInstruction": {"parts": [{"text": TRANSLATION_INSTRUCTIONS}]},
        "contents": [{"role": "user", "parts": [{"text": json.dumps(prompt, ensure_ascii=False)}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema},
    }
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model, safe='')}:generateContent"
    request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"x-goog-api-key": api_key, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"پاسخ نامعتبر جمنای با کد {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"اتصال به جمنای برقرار نشد: {error.reason}") from error

    parts = (((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    output_text = "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    if not output_text:
        raise RuntimeError("خروجی جمنای خالی بود.")
    decoded = json.loads(output_text)
    expected = {item.key for item in batch}
    results: dict[str, dict[str, str]] = {}
    for item in decoded.get("translations", []):
        key = item.get("key")
        translated_name = clean_name(item.get("translated_name"))
        if key in expected and translated_name:
            results[key] = {"translated_name": translated_name, "strategy": item.get("strategy", "mixed")}
    missing = expected - results.keys()
    if missing:
        raise RuntimeError(f"جمنای برای {len(missing)} نام خروجی معتبر برنگرداند.")
    return results


def request_local_batch(batch: list[Candidate], endpoint: str) -> dict[str, dict[str, str]]:
    body = {"items": [{"key": item.key, "sourceName": item.source_name, "layer": item.layer,
                       "className": item.class_name} for item in batch]}
    request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"سرویس مدل آفلاین با کد {error.code} پاسخ نامعتبر داد: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"اتصال به سرویس مدل آفلاین برقرار نشد: {error.reason}") from error
    expected = {item.key for item in batch}
    results = {item.get("key"): {"translated_name": clean_name(item.get("translatedName")),
                                 "strategy": item.get("strategy", "mixed"),
                                 "provider": item.get("provider") or payload.get("provider") or "local"}
               for item in payload.get("translations", [])
               if item.get("key") in expected and clean_name(item.get("translatedName"))}
    missing = expected - results.keys()
    if missing:
        raise RuntimeError(f"مدل آفلاین برای {len(missing)} نام خروجی معتبر برنگرداند.")
    return results


def translate_candidates(
    candidates: list[Candidate], cache: dict[str, dict[str, Any]], cache_path: Path,
    provider: str, model: str, api_key: str, batch_size: int, demo_file: Path, local_endpoint: str,
) -> None:
    demo: dict[str, str] = {}
    if provider == "demo":
        demo = json.loads(demo_file.read_text(encoding="utf-8"))

    for offset in range(0, len(candidates), batch_size):
        batch = candidates[offset:offset + batch_size]
        if provider == "demo":
            results = {item.key: {"translated_name": demo[item.source_name], "strategy": "mixed"}
                       for item in batch if item.source_name in demo}
        else:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    if provider == "gemini":
                        results = request_gemini_batch(batch, api_key, model)
                    elif provider == "local":
                        results = request_local_batch(batch, local_endpoint)
                    else:
                        results = request_openai_batch(batch, api_key, model)
                    break
                except (RuntimeError, json.JSONDecodeError) as error:
                    last_error = error
                    if attempt < 2:
                        time.sleep(2 ** attempt)
            else:
                raise RuntimeError(f"ترجمهٔ دسته پس از سه تلاش ناموفق بود: {last_error}")

        now = datetime.now(timezone.utc).isoformat()
        for candidate in batch:
            result = results.get(candidate.key)
            if not result:
                continue
            cache[candidate.key] = {
                "source_name": candidate.source_name,
                "layer": candidate.layer,
                "class": candidate.class_name,
                "translated_name": result["translated_name"],
                "strategy": result["strategy"],
                "provider": result.get("provider") or (f"google:{model}" if provider == "gemini" else f"openai:{model}"
                if provider == "openai" else f"local:{model}" if provider == "local" else "demo:reviewed-sample"),
                "fingerprint": candidate.fingerprint,
                "translated_at": now,
            }
        save_cache(cache_path, cache)
        print(f"پیشرفت: {min(offset + len(batch), len(candidates))} از {len(candidates)} نام یکتا")


def rewrite_sql(input_path: Path, output_path: Path, cache: dict[str, dict[str, Any]]) -> dict[str, int]:
    if input_path.resolve() == output_path.resolve():
        raise SystemExit("مسیر خروجی نباید با فایل ورودی یکسان باشد.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stats = {"rows": 0, "updated": 0, "unchanged": 0}
    inside_copy = False
    with input_path.open("r", encoding="utf-8", newline="") as source, output_path.open("w", encoding="utf-8", newline="") as target:
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
            stats["rows"] += 1
            candidate = candidate_from_fields(fields)
            entry = cached_translation(candidate, cache) if candidate else None
            if not candidate or not entry:
                stats["unchanged"] += 1
                target.write(line)
                continue

            properties = parse_json_copy(fields[4])
            translation = parse_json_copy(fields[5])
            for key in EDIT_KEYS:
                translation.pop(key, None)
                properties.pop(key, None)
            translation["name"] = clean_name(entry.get("translated_name"))
            fields[4] = encode_json_copy(properties)
            fields[5] = encode_json_copy(translation)
            target.write("\t".join(fields) + newline)
            stats["updated"] += 1
    return stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="پویش، ترجمه و تولید نسخهٔ جدید فایل SQL نقشه")
    parser.add_argument("input", type=Path, help="مسیر فایل SQL ورودی")
    parser.add_argument("--output", type=Path, help="مسیر فایل SQL خروجی")
    parser.add_argument("--cache", type=Path, help="مسیر حافظهٔ ادامه‌پذیر ترجمه")
    parser.add_argument("--provider", choices=("gemini", "openai", "local", "demo"), default=os.environ.get("TRANSLATION_PROVIDER", "local"))
    parser.add_argument("--model")
    parser.add_argument("--local-endpoint", default=os.environ.get("LOCAL_TRANSLATION_PREVIEW_URL",
                        "http://127.0.0.1:3006/api/v1/translation-previews"))
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--limit", type=int, default=0, help="حداکثر تعداد نام یکتا؛ صفر یعنی همه")
    parser.add_argument("--dry-run", action="store_true", help="فقط گزارش پویش؛ بدون ترجمه یا تولید خروجی")
    parser.add_argument("--demo-file", type=Path, default=Path(__file__).parents[1] / "examples" / "demo-translations.json")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    input_path: Path = args.input
    if not input_path.is_file():
        raise SystemExit(f"فایل ورودی پیدا نشد: {input_path}")
    if args.batch_size < 1 or args.batch_size > 50:
        raise SystemExit("اندازهٔ دسته باید بین ۱ تا ۵۰ باشد.")

    output_path = args.output or input_path.with_name(input_path.stem + "_translated.sql")
    cache_path = args.cache or output_path.with_suffix(".translation-cache.json")
    if args.provider == "gemini":
        args.model = args.model or os.environ.get("GEMINI_TRANSLATION_MODEL", "gemini-3.5-flash-lite")
    elif args.provider == "openai":
        args.model = args.model or os.environ.get("OPENAI_TRANSLATION_MODEL", "gpt-5.4-nano")
    elif args.provider == "local":
        args.model = args.model or os.environ.get("LOCAL_TRANSLATION_MODEL", "translator-local-qwen")
    else:
        args.model = None
    candidates, scan_stats = scan_file(input_path)
    print(json.dumps({"scan": scan_stats}, ensure_ascii=False, indent=2))
    if args.dry_run:
        return

    cache = load_cache(cache_path)
    unresolved = [candidate for candidate in candidates.values() if not cached_translation(candidate, cache)]
    if args.provider == "demo":
        demo = json.loads(args.demo_file.read_text(encoding="utf-8"))
        unresolved = [candidate for candidate in unresolved if candidate.source_name in demo]
    if args.limit > 0:
        unresolved = unresolved[:args.limit]
    if args.provider in ("gemini", "openai") and unresolved:
        key_name = "GEMINI_API_KEY" if args.provider == "gemini" else "OPENAI_API_KEY"
        api_key = os.environ.get(key_name, "").strip()
        if not api_key:
            raise SystemExit(f"متغیر {key_name} تنظیم نشده است؛ ابتدا حالت dry-run یا demo را اجرا کنید.")
    else:
        api_key = ""

    if unresolved:
        translate_candidates(unresolved, cache, cache_path, args.provider, args.model, api_key, args.batch_size,
                             args.demo_file, args.local_endpoint)
    rewrite_stats = rewrite_sql(input_path, output_path, cache)
    report = {
        "input": str(input_path), "output": str(output_path), "cache": str(cache_path),
        "provider": args.provider, "model": args.model if args.provider != "demo" else None,
        "scan": scan_stats, "rewrite": rewrite_stats,
    }
    report_path = output_path.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nپردازش متوقف شد؛ ترجمه‌های ذخیره‌شده در اجرای بعدی استفاده می‌شوند.", file=sys.stderr)
        raise SystemExit(130)
