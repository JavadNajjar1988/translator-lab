from __future__ import annotations

import sys
import tempfile
import unittest
import json
from unittest import mock
from pathlib import Path


PROJECT_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from process_sql_translations import (  # noqa: E402
    Candidate,
    candidate_from_fields,
    encode_json_copy,
    parse_json_copy,
    request_local_batch,
    rewrite_sql,
    scan_file,
)
from review_translation_glossary import issues  # noqa: E402


def row(properties: dict, translation: dict | None) -> list[str]:
    return [
        "W", "42", "00", "transportation_name", encode_json_copy(properties),
        encode_json_copy(translation) if translation is not None else r"\N",
        *("f" for _ in range(15)),
    ]


def sql_with_rows(rows: list[list[str]]) -> str:
    header = "COPY public.geoms (osm_type, osm_id, geom, layer, properties, translate, zoom_0, zoom_1, zoom_2, zoom_3, zoom_4, zoom_5, zoom_6, zoom_7, zoom_8, zoom_9, zoom_10, zoom_11, zoom_12, zoom_13, zoom_14) FROM stdin;\n"
    return header + "\n".join("\t".join(item) for item in rows) + "\n\\.\n"


class TranslationProcessorTests(unittest.TestCase):
    def test_local_provider_uses_the_central_offline_preview_service(self):
        candidate = Candidate("key-1", "Avenue du Port", "transportation_name", "secondary", "fp", False)
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"provider": "local:test", "translations": [{
            "key": "key-1", "translatedName": "خیابان بندر", "strategy": "translation",
        }]}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=response) as opened:
            result = request_local_batch([candidate], "http://127.0.0.1:3006/api/v1/translation-previews")
        self.assertEqual(result["key-1"]["translated_name"], "خیابان بندر")
        self.assertEqual(opened.call_args.args[0].full_url,
                         "http://127.0.0.1:3006/api/v1/translation-previews")

    def test_glossary_review_detects_bad_generic_transliterations(self):
        self.assertIn("Avenue=خیابان", issues("Avenue Jacques Abba", "آونیو ژاک آبا"))
        self.assertIn("Stade=ورزشگاه", issues("Impasse du Stade", "بن‌بست دو استاد"))
        self.assertEqual(issues("Avenue du Port", "خیابان بندر"), [])

    def test_scan_obeys_empty_existing_and_edit_rules(self):
        rows = [
            row({}, None),
            row({"name": "A"}, {"name": "الف"}),
            row({"name": "B"}, None),
            row({"name": "C"}, {"name": "ج", "edit": True}),
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.sql"
            source.write_text(sql_with_rows(rows), encoding="utf-8")
            candidates, stats = scan_file(source)

        self.assertEqual(stats["no_source"], 1)
        self.assertEqual(stats["translated"], 1)
        self.assertEqual(stats["new"], 1)
        self.assertEqual(stats["retranslate"], 1)
        self.assertEqual(len(candidates), 2)

    def test_rewrite_preserves_input_and_clears_processed_edit_flag(self):
        fields = row({"name": "Avenue du Port", "edit": True}, {"name": "قدیمی", "name:en": "Port Avenue", "edit": True})
        candidate = candidate_from_fields(fields)
        self.assertIsNotNone(candidate)
        cache = {candidate.key: {
            "translated_name": "خیابان بندر",
            "fingerprint": candidate.fingerprint,
        }}

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.sql"
            output = Path(directory) / "output.sql"
            original = sql_with_rows([fields])
            source.write_text(original, encoding="utf-8")
            stats = rewrite_sql(source, output, cache)
            rewritten_fields = list(output.read_text(encoding="utf-8").splitlines()[1].split("\t"))

            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.assertEqual(stats["updated"], 1)
            self.assertNotEqual(source.read_bytes(), output.read_bytes())
            properties = parse_json_copy(rewritten_fields[4])
            translation = parse_json_copy(rewritten_fields[5])
            self.assertNotIn("edit", properties)
            self.assertNotIn("edit", translation)
            self.assertEqual(translation["name"], "خیابان بندر")
            self.assertEqual(translation["name:en"], "Port Avenue")


if __name__ == "__main__":
    unittest.main()
