import assert from "node:assert/strict";
import test from "node:test";
import { judgeProperNameTranslations } from "../server/proper-name-judge.mjs";

function preserveEnvironment(context, names) {
  const original = new Map(names.map((name) => [name, process.env[name]]));
  context.after(() => original.forEach((value, name) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }));
}

test("judge is disabled unless shadow evaluation is explicitly enabled", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED"]);
  delete process.env.PROPER_NAME_JUDGE_ENABLED;
  assert.equal(await judgeProperNameTranslations([], []), null);
});

test("judge uses LM Studio native API with reasoning disabled", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL",
    "PROPER_NAME_JUDGE_MODEL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  process.env.PROPER_NAME_JUDGE_MODEL = "qwen3.5-4b";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "http://judge.test/api/v1/chat");
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning, "off");
    assert.equal(body.store, false);
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: "one", decision: "accept", corrected: "دیور", reason_code: "none",
    }] }) }] }), { status: 200 });
  });
  const result = await judgeProperNameTranslations([
    { key: "one", sourceName: "Dior", layer: "poi", className: "shop" },
  ], [{ key: "one", translatedName: "دیور" }]);
  assert.equal(result.status, "observed");
  assert.deepEqual(result.judgements.get("one"), {
    decision: "accept", suggestedName: "دیور", reasonCode: "none",
  });
});

test("judge marks internally inconsistent decisions invalid", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output: [{
    type: "message", content: '{"items":[{"key":"one","decision":"accept","corrected":"دایر","reason_code":"none"}]}',
  }] }), { status: 200 }));
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "دیور" }]);
  assert.equal(result.status, "invalid");
  assert.equal(result.judgements.get("one").decision, "invalid");
});

test("judge cannot call an unchanged candidate a correction", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output: [{
    type: "message", content: '{"items":[{"key":"one","decision":"correct","corrected":"باغ","reason_code":"generic_term"}]}',
  }] }), { status: 200 }));
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "باغ" }]);
  assert.equal(result.status, "invalid");
  assert.equal(result.judgements.get("one").decision, "invalid");
});

test("judge may reject a candidate without inventing a replacement", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output: [{
    type: "message", content: '{"items":[{"key":"one","decision":"reject","corrected":"متن مشکوک","reason_code":"identity_loss"}]}',
  }] }), { status: 200 }));
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "متن مشکوک" }]);
  assert.equal(result.status, "observed");
  assert.equal(result.judgements.get("one").decision, "reject");
});

test("judge may accept a candidate without repeating it in corrected", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ output: [{
    type: "message", content: '{"items":[{"key":"one","decision":"accept","reason_code":"none"}]}',
  }] }), { status: 200 }));
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "دیور" }]);
  assert.equal(result.status, "observed");
  assert.equal(result.judgements.get("one").suggestedName, "دیور");
});

test("judge defaults to one name per request for reliable local output", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL",
    "PROPER_NAME_JUDGE_BATCH_SIZE"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  delete process.env.PROPER_NAME_JUDGE_BATCH_SIZE;
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const requested = JSON.parse(JSON.parse(options.body).input).items[0];
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: requested.key, decision: "accept", corrected: requested.candidate, reason_code: "none",
    }] }) }] }), { status: 200 });
  });
  const translations = [{ key: "one", translatedName: "دیور" }, { key: "two", translatedName: "لاروتو" }];
  const result = await judgeProperNameTranslations([], translations);
  assert.equal(calls, 2);
  assert.equal(result.judgements.size, 2);
});

test("cascade judge accepts only when both local models accept", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL",
    "PROPER_NAME_JUDGE_MODEL", "PROPER_NAME_JUDGE_SECONDARY_MODEL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  process.env.PROPER_NAME_JUDGE_MODEL = "qwen3.5-4b";
  process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL = "qwen3.5-9b";
  const requestedModels = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedModels.push(body.model);
    const requested = JSON.parse(body.input).items[0];
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: requested.key, decision: "accept", corrected: requested.candidate, reason_code: "none",
    }] }) }] }), { status: 200 });
  });
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "دیور" }]);
  assert.deepEqual(requestedModels, ["qwen3.5-4b", "qwen3.5-9b"]);
  assert.equal(result.provider, "local-judge-consensus:qwen3.5-4b+qwen3.5-9b");
  assert.deepEqual(result.judgements.get("one"), {
    decision: "accept", suggestedName: "دیور", reasonCode: "consensus_accept", consensus: true,
    votes: [
      { model: "qwen3.5-4b", decision: "accept", suggestedName: "دیور", reasonCode: "none" },
      { model: "qwen3.5-9b", decision: "accept", suggestedName: "دیور", reasonCode: "none" },
    ],
  });
});

test("cascade judge rejects a candidate when the second model disagrees", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL",
    "PROPER_NAME_JUDGE_MODEL", "PROPER_NAME_JUDGE_SECONDARY_MODEL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  process.env.PROPER_NAME_JUDGE_MODEL = "qwen3.5-4b";
  process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL = "qwen3.5-9b";
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    const requested = JSON.parse(body.input).items[0];
    const decision = body.model === "qwen3.5-4b" ? "accept" : "reject";
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: requested.key, decision, corrected: requested.candidate,
      reason_code: decision === "accept" ? "none" : "identity_loss",
    }] }) }] }), { status: 200 });
  });
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "کافه میلان" }]);
  const judgement = result.judgements.get("one");
  assert.equal(judgement.decision, "reject");
  assert.equal(judgement.consensus, false);
  assert.equal(judgement.reasonCode, "judge_disagreement");
  assert.equal(judgement.votes.length, 2);
});

test("cascade judge does not call the larger model after a primary rejection", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_BASE_URL",
    "PROPER_NAME_JUDGE_MODEL", "PROPER_NAME_JUDGE_SECONDARY_MODEL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_BASE_URL = "http://judge.test/api/v1";
  process.env.PROPER_NAME_JUDGE_MODEL = "qwen3.5-4b";
  process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL = "qwen3.5-9b";
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const requested = JSON.parse(JSON.parse(options.body).input).items[0];
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: requested.key, decision: "reject", corrected: requested.candidate, reason_code: "identity_loss",
    }] }) }] }), { status: 200 });
  });
  const result = await judgeProperNameTranslations([], [{ key: "one", translatedName: "خانه قدیمی" }]);
  assert.equal(calls, 1);
  assert.equal(result.judgements.get("one").decision, "reject");
  assert.equal(result.judgements.get("one").votes.length, 1);
});

test("deterministic quality rules reject known unsafe candidates before either model", async (context) => {
  preserveEnvironment(context, ["PROPER_NAME_JUDGE_ENABLED", "PROPER_NAME_JUDGE_MODEL",
    "PROPER_NAME_JUDGE_SECONDARY_MODEL"]);
  process.env.PROPER_NAME_JUDGE_ENABLED = "true";
  process.env.PROPER_NAME_JUDGE_MODEL = "qwen3.5-4b";
  process.env.PROPER_NAME_JUDGE_SECONDARY_MODEL = "qwen3.5-9b";
  context.mock.method(globalThis, "fetch", async () => assert.fail("quality rejection must not call a model"));
  const result = await judgeProperNameTranslations([
    { key: "gallery", sourceName: "Willliam Grover;William Grover", layer: "poi", className: "art_gallery" },
    { key: "cafe", sourceName: "Caffè Milano", layer: "poi", className: "amenity" },
  ], [
    { key: "gallery", translatedName: "ویلیام گروور" },
    { key: "cafe", translatedName: "کافه میلان" },
  ]);
  assert.equal(result.provider, "deterministic-quality");
  assert.equal(result.status, "observed");
  assert.deepEqual([...result.judgements.values()].map((item) => ({ decision: item.decision,
    reasonCode: item.reasonCode, issues: item.qualityIssues })), [
    { decision: "reject", reasonCode: "quality_rule", issues: ["class:art_gallery=گالری"] },
    { decision: "reject", reasonCode: "quality_rule", issues: ["Caffè Milano=کافه میلانو"] },
  ]);
});
