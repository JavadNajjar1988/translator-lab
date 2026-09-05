import assert from "node:assert/strict";
import test from "node:test";

import { decideTranslation, summarizeTranslationQueue } from "../app/translation-policy.ts";

test("رکورد بدون properties.name از صف ترجمه کنار گذاشته می‌شود", () => {
  assert.equal(decideTranslation({ sourceName: "   " }), "skip_no_source");
});

test("ترجمهٔ موجود بدون تگ ویرایش حفظ می‌شود", () => {
  assert.equal(decideTranslation({ sourceName: "Avenue du Port", translatedName: "خیابان بندر" }), "skip_translated");
});

test("تگ ویرایش حتی با وجود ترجمه، رکورد را وارد صف بازترجمه می‌کند", () => {
  assert.equal(decideTranslation({ sourceName: "Avenue du Port", translatedName: "خیابان بندر", editRequested: true }), "retranslate");
});

test("خلاصهٔ پویش هر چهار تصمیم را جداگانه گزارش می‌کند", () => {
  assert.deepEqual(summarizeTranslationQueue([
    { sourceName: "" },
    { sourceName: "A", translatedName: "الف" },
    { sourceName: "B" },
    { sourceName: "C", translatedName: "ج", editRequested: true },
  ]), { skip_no_source: 1, skip_translated: 1, translate_new: 1, retranslate: 1 });
});
