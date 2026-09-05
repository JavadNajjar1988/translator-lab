from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from build_approved_translation_assets import FORMAT_VERSION, stratified_evaluation


def build_evaluation(memory_path: Path, output_path: Path, limit: int = 500) -> dict:
    payload = json.loads(memory_path.read_text(encoding="utf-8"))
    entries = [entry for entry in payload.get("entries", [])
               if entry.get("approval_status") == "client_approved"]
    if not entries:
        raise ValueError("حافظهٔ ترجمه هیچ مدخل تأییدشده‌ای ندارد.")
    selected = stratified_evaluation(entries, limit)
    evaluation = {
        "format_version": FORMAT_VERSION,
        "source_sha256": payload.get("source_sha256"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "selection": "deterministic_layer_round_robin",
        "entry_count": len(selected),
        "entries": selected,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return evaluation


def main() -> None:
    parser = argparse.ArgumentParser(description="ساخت مجموعهٔ ارزیابی از حافظهٔ تأییدشده")
    parser.add_argument("--memory", type=Path,
                        default=Path("work/approved-translations/translation-memory.json"))
    parser.add_argument("--output", type=Path,
                        default=Path("work/approved-translations/evaluation-set.json"))
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()
    if not args.memory.is_file():
        raise SystemExit(f"حافظهٔ ترجمه پیدا نشد: {args.memory}")
    evaluation = build_evaluation(args.memory, args.output, max(1, args.limit))
    print(json.dumps({"output": str(args.output), "entry_count": evaluation["entry_count"],
                      "source_sha256": evaluation["source_sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
