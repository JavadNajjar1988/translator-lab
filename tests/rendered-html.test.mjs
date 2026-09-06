import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const bindings = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

test("صفحه اصلی محیط کنترل را رندر می‌کند", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), bindings, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /سامانه مترجم عوارض نقشه/);
  assert.match(html, /کنترل رکوردها/);
  assert.match(html, /پویشگر ترجمه/);
  assert.match(html, /حالت اجرا/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/);
});

test("داده استخراج‌شده با آمار فایل کارفرما منطبق است", async () => {
  const raw = await readFile(new URL("../public/data/map-data.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.features.length, 8975);
  assert.equal(data.meta.stats.named, 2377);
  assert.equal(data.meta.stats.pending, 2377);
  assert.equal(data.meta.stats.translated, 0);
  assert.equal(data.meta.stats.no_source, 6598);
  assert.ok(data.features.every((feature) => feature.geometry?.type));
});

test("رابط ترجمه نام خالی را بدون فراخوانی مدل رد می‌کند", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceName: "" }),
  }), bindings, context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /نام مبدأ خالی/);
});

test("نبود کلید جمنای با پیام کنترل‌شده گزارش می‌شود", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceName: "Avenue du Port", layer: "transportation_name" }),
  }), bindings, context);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /کلید جمنای/);
});

test("ترجمهٔ گروهی بدون کلید جمنای فراخوانی بیرونی انجام نمی‌دهد", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/translate-batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ key: "a", sourceName: "Avenue du Port", layer: "transportation_name" }] }),
  }), bindings, context);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /کلید جمنای/);
});
