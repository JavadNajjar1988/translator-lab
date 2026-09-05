from __future__ import annotations

import os
import re
import threading
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


MODEL_ID = os.environ.get("MADLAD_MODEL_ID", "google/madlad400-3b-mt")
MODEL_PATH = Path(os.environ.get("MADLAD_MODEL_PATH", MODEL_ID))
MAX_BATCH_SIZE = max(1, min(32, int(os.environ.get("MADLAD_MAX_BATCH_SIZE", "20"))))
MAX_SOURCE_LENGTH = max(32, min(512, int(os.environ.get("MADLAD_MAX_SOURCE_LENGTH", "256"))))
MAX_NEW_TOKENS = max(16, min(256, int(os.environ.get("MADLAD_MAX_NEW_TOKENS", "96"))))


_ARABIC_TO_PERSIAN = str.maketrans({
    "ي": "ی", "ى": "ی", "ك": "ک", "ۀ": "هٔ", "ة": "ه", "ؤ": "و",
    "إ": "ا", "أ": "ا", "ٱ": "ا",
})
_ARABIC_DIACRITICS = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")
_TRAILING_SENTENCE_PUNCTUATION = re.compile(r"[.!?؟。]+$")


def normalize_persian_translation(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value).translate(_ARABIC_TO_PERSIAN)
    normalized = _ARABIC_DIACRITICS.sub("", normalized).replace("ـ", "")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return _TRAILING_SENTENCE_PUNCTUATION.sub("", normalized).strip()


class TranslationItem(BaseModel):
    key: str = Field(min_length=1, max_length=160)
    source_name: str = Field(min_length=1, max_length=500)
    layer: str = Field(default="", max_length=160)
    class_name: str = Field(default="", alias="class", max_length=160)


class TranslationRequest(BaseModel):
    target_language: Literal["fa"] = "fa"
    items: list[TranslationItem] = Field(min_length=1)


class TranslationResult(BaseModel):
    key: str
    translated_name: str
    strategy: Literal["translation", "transliteration", "mixed"] = "mixed"


class TranslationResponse(BaseModel):
    provider: str
    translations: list[TranslationResult]


class MadladRuntime:
    def __init__(self) -> None:
        self.tokenizer = None
        self.model = None
        self.device = "unloaded"
        self.error = ""
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.tokenizer is not None and self.model is not None

    def load(self) -> None:
        if self.ready:
            return
        try:
            if not MODEL_PATH.exists() and str(MODEL_PATH) != MODEL_ID:
                raise RuntimeError(f"Model directory does not exist: {MODEL_PATH}")
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is unavailable; install the CUDA build of PyTorch.")
            self.device = "cuda"
            self.tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH), local_files_only=MODEL_PATH.exists())
            self.model = AutoModelForSeq2SeqLM.from_pretrained(
                str(MODEL_PATH),
                local_files_only=MODEL_PATH.exists(),
                dtype=torch.float16,
                low_cpu_mem_usage=True,
            ).to(self.device)
            self.model.eval()
            self.error = ""
        except Exception as exc:
            self.error = str(exc)
            self.tokenizer = None
            self.model = None
            raise

    def translate(self, items: list[TranslationItem], target_language: str) -> list[TranslationResult]:
        if not self.ready:
            raise RuntimeError(self.error or "Model is not loaded.")
        prompts = [f"<2{target_language}> {item.source_name.strip()}" for item in items]
        with self._lock, torch.inference_mode():
            encoded = self.tokenizer(
                prompts,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=MAX_SOURCE_LENGTH,
            ).to(self.device)
            generated = self.model.generate(
                **encoded,
                do_sample=False,
                num_beams=1,
                max_new_tokens=MAX_NEW_TOKENS,
            )
            decoded = self.tokenizer.batch_decode(generated, skip_special_tokens=True)
        results = []
        for item, translated_name in zip(items, decoded, strict=True):
            translated_name = normalize_persian_translation(translated_name)
            if not translated_name:
                raise RuntimeError(f"Empty translation for key: {item.key}")
            results.append(TranslationResult(key=item.key, translated_name=translated_name, strategy="mixed"))
        return results


runtime = MadladRuntime()


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.load()
    yield


app = FastAPI(title="Translator Lab MADLAD service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok" if runtime.ready else "loading",
        "ready": runtime.ready,
        "model": MODEL_ID,
        "device": runtime.device,
        "error": runtime.error or None,
    }


@app.post("/v1/translations", response_model=TranslationResponse)
def translate(payload: TranslationRequest) -> TranslationResponse:
    if len(payload.items) > MAX_BATCH_SIZE:
        raise HTTPException(status_code=413, detail=f"Batch size exceeds {MAX_BATCH_SIZE}.")
    keys = [item.key for item in payload.items]
    if len(keys) != len(set(keys)):
        raise HTTPException(status_code=400, detail="Item keys must be unique.")
    try:
        translations = runtime.translate(payload.items, payload.target_language)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return TranslationResponse(provider=f"madlad:{MODEL_ID}", translations=translations)
