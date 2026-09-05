import unittest
from unittest import mock


class MadladServiceContractTests(unittest.TestCase):
    def test_persian_output_is_normalized_for_map_labels(self):
        from services.madlad.app import normalize_persian_translation

        self.assertEqual(normalize_persian_translation("  بيمارستان مركزي.  "), "بیمارستان مرکزی")
        self.assertEqual(normalize_persian_translation("ايستگاه  قطار؟"), "ایستگاه قطار")

    def test_translation_contract_preserves_keys(self):
        from services.madlad import app as service

        items = [service.TranslationItem(key="one", source_name="Central Station")]
        with mock.patch.object(service.runtime, "translate", return_value=[
            service.TranslationResult(key="one", translated_name="ایستگاه مرکزی", strategy="translation")
        ]):
            response = service.translate(service.TranslationRequest(items=items))

        self.assertEqual(response.provider, "madlad:google/madlad400-3b-mt")
        self.assertEqual(response.translations[0].key, "one")
        self.assertEqual(response.translations[0].translated_name, "ایستگاه مرکزی")

    def test_duplicate_keys_are_rejected(self):
        from fastapi import HTTPException
        from services.madlad import app as service

        payload = service.TranslationRequest(items=[
            service.TranslationItem(key="same", source_name="One"),
            service.TranslationItem(key="same", source_name="Two"),
        ])
        with self.assertRaises(HTTPException) as caught:
            service.translate(payload)
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
