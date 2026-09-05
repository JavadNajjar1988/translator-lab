import assert from "node:assert/strict";
import test from "node:test";

import { applyTranslationsToSql, scanSqlText } from "../app/sql-workflow.ts";

function row(properties, translation = null, id = "42") {
  return ["W", id, "00", "transportation_name", JSON.stringify(properties),
    translation ? JSON.stringify(translation) : "\\N", ...Array(15).fill("f")].join("\t");
}

function sql(rows) {
  return `COPY public.geoms (osm_type, osm_id, geom, layer, properties, translate, zoom_0, zoom_1, zoom_2, zoom_3, zoom_4, zoom_5, zoom_6, zoom_7, zoom_8, zoom_9, zoom_10, zoom_11, zoom_12, zoom_13, zoom_14) FROM stdin;\n${rows.join("\n")}\n\\.\n`;
}

test("پویش مرورگری قواعد نام خالی، ترجمهٔ موجود و تگ ویرایش را رعایت می‌کند", () => {
  const result = scanSqlText(sql([
    row({}, null, "1"),
    row({ name: "A" }, { name: "الف" }, "2"),
    row({ name: "B" }, null, "3"),
    row({ name: "C" }, { name: "ج", edit: true }, "4"),
  ]));
  assert.deepEqual(result.stats, {
    total: 4, noSource: 1, translated: 1, pending: 1, retranslate: 1, uniqueCandidates: 2,
  });
});

test("تولید فایل کامل، ورودی را تغییر نمی‌دهد و تگ ویرایش را پاک می‌کند", () => {
  const input = sql([row({ name: "Avenue du Port", edit: true }, { name: "قدیمی", "name:en": "Port Avenue", edit: true })]);
  const candidate = scanSqlText(input).candidates[0];
  const { output, updated } = applyTranslationsToSql(input, {
    [candidate.key]: { translatedName: "خیابان بندر", strategy: "mixed", provider: "test",
      fingerprint: candidate.fingerprint, translatedAt: new Date(0).toISOString() },
  });
  assert.equal(updated, 1);
  assert.match(input, /قدیمی/);
  assert.match(output, /خیابان بندر/);
  assert.match(output, /Port Avenue/);
  assert.doesNotMatch(output, /"edit"/);
});
