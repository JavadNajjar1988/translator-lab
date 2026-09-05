import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSemanticEquivalence, normalizeComparable } from "../server/semantic-equivalence.mjs";

test("normalization unifies Persian letters, digits, punctuation, and spacing", () => {
  assert.equal(normalizeComparable("  بارِ سوشی ۹۹، "), "بار سوشی 99");
  assert.equal(normalizeComparable("كافه‌ ميلانو"), "کافه میلانو");
});

test("token reordering is resolved without a model", async (context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("reordered tokens must not call a model"));
  const result = await evaluateSemanticEquivalence([{ key: "one", sourceName: "99 Sushi Bar",
    reference: "بار سوشی ۹۹", candidate: "99 سوشی بار" }]);
  assert.deepEqual(result.get("one"), { decision: "equivalent", reasonCode: "word_order",
    provider: "deterministic-equivalence" });
});

test("unclear differences are sent to the configured offline semantic judge", async (context) => {
  const originalModel = process.env.SEMANTIC_JUDGE_MODEL;
  process.env.SEMANTIC_JUDGE_MODEL = "semantic-test";
  context.after(() => { if (originalModel === undefined) delete process.env.SEMANTIC_JUDGE_MODEL;
    else process.env.SEMANTIC_JUDGE_MODEL = originalModel; });
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "semantic-test");
    assert.equal(body.reasoning, "off");
    return new Response(JSON.stringify({ output: [{ type: "message", content: JSON.stringify({ items: [{
      key: "one", decision: "different", reason_code: "identity_change",
    }] }) }] }), { status: 200 });
  });
  const result = await evaluateSemanticEquivalence([{ key: "one", sourceName: "Rue Bosio",
    reference: "خیابان بوزیو", candidate: "خیابان بوش" }]);
  assert.deepEqual(result.get("one"), { decision: "different", reasonCode: "identity_change",
    provider: "semantic-judge:semantic-test" });
});
