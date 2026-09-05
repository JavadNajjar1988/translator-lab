from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from build_approved_translation_assets import collect_approved_entries, write_assets  # noqa: E402
from process_sql_translations import encode_json_copy  # noqa: E402


def row(source_name: str | None, translated_name: str | None, layer: str = "transportation_name", class_name: str = "minor") -> list[str]:
    properties = {"name": source_name, "class": class_name} if source_name is not None else {}
    translation = {"name": translated_name} if translated_name is not None else None
    return [
        "W", "42", "00", layer, encode_json_copy(properties),
        encode_json_copy(translation) if translation is not None else r"\N",
        *("f" for _ in range(15)),
    ]


def sql_with_rows(rows: list[list[str]]) -> str:
    header = "COPY public.geoms (osm_type, osm_id, geom, layer, properties, translate, zoom_0, zoom_1, zoom_2, zoom_3, zoom_4, zoom_5, zoom_6, zoom_7, zoom_8, zoom_9, zoom_10, zoom_11, zoom_12, zoom_13, zoom_14) FROM stdin;\n"
    return header + "\n".join("\t".join(item) for item in rows) + "\n\\.\n"


class ApprovedTranslationAssetsTests(unittest.TestCase):
    def test_builds_unique_memory_and_layer_balanced_evaluation(self):
        rows = [
            row(None, None),
            row("Avenue du Port", "خیابان بندر"),
            row("Avenue du Port", "خیابان بندر"),
            row("Gare de Monaco", "ایستگاه موناکو", "poi", "railway"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "approved.sql"
            output = root / "assets"
            source.write_text(sql_with_rows(rows), encoding="utf-8")
            manifest = write_assets(source, output, evaluation_limit=2, approved_at="2026-08-29")
            memory = json.loads((output / "translation-memory.json").read_text(encoding="utf-8"))
            evaluation = json.loads((output / "evaluation-set.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["stats"]["total_rows"], 4)
        self.assertEqual(manifest["stats"]["rows_without_source_name"], 1)
        self.assertEqual(manifest["stats"]["duplicate_rows"], 1)
        self.assertEqual(manifest["stats"]["unique_entries"], 2)
        self.assertEqual(len(memory["entries"]), 2)
        self.assertEqual({item["layer"] for item in evaluation["entries"]}, {"poi", "transportation_name"})

    def test_rejects_named_rows_without_translation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "incomplete.sql"
            source.write_text(sql_with_rows([row("Rue Test", None)]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "فاقد ترجمه"):
                write_assets(source, root / "assets")

    def test_reports_conflicting_approved_translations(self):
        rows = [row("Port Hercule", "بندر هرکول"), row("Port Hercule", "بندر ارکول")]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "conflict.sql"
            source.write_text(sql_with_rows(rows), encoding="utf-8")
            _, stats = collect_approved_entries(source, "fr", "fa")

        self.assertEqual(len(stats["conflicts"]), 1)


if __name__ == "__main__":
    unittest.main()
