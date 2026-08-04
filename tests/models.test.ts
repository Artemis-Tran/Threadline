import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, DEFAULT_MODEL } from "../src/models";

// Output tokens a single OpenAI extraction call actually spends at the pinned
// effort: 167,647 across the reference book's 47 calls on Luna at high. The
// figure the registry's ceiling has to clear, measured rather than assumed.
const OPENAI_MEASURED_OUTPUT_PER_CALL = 3567;

describe("resolveModel", () => {
  test("resolves friendly aliases to full IDs", () => {
    assert.equal(resolveModel("sonnet").id, "claude-sonnet-5");
    assert.equal(resolveModel("haiku").id, "claude-haiku-4-5");
    assert.equal(resolveModel("opus").id, "claude-opus-4-8");
    assert.equal(resolveModel("luna").id, "gpt-5.6-luna");
    assert.equal(resolveModel("terra").id, "gpt-5.6-terra");
  });

  test("is idempotent on an already-resolved ID", () => {
    assert.equal(resolveModel("claude-haiku-4-5").id, "claude-haiku-4-5");
    assert.equal(resolveModel("gpt-5.6-luna").id, "gpt-5.6-luna");
  });

  test("carries per-model rates", () => {
    assert.deepEqual(resolveModel("haiku").rates, { inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
    assert.deepEqual(resolveModel("sonnet").rates, { inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
    assert.deepEqual(resolveModel("luna").rates, { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 });
    assert.deepEqual(resolveModel("terra").rates, { inputUsdPerMTok: 2, outputUsdPerMTok: 12 });
  });

  test("carries the vendor that serves each row", () => {
    assert.equal(resolveModel("sonnet").provider, "anthropic");
    assert.equal(resolveModel("luna").provider, "openai");
    assert.equal(resolveModel("terra").provider, "openai");
  });

  test("carries an output-token estimate for the cost gate", () => {
    // Pinned for the Anthropic rows because the extract step's gate used to hardcode
    // 2000 — a `--model sonnet` estimate has to come out unchanged. (That was the
    // no-flag estimate until the default moved to Luna; the figure is unchanged.)
    assert.equal(resolveModel("sonnet").outputTokenEstimate, 2000);
    assert.equal(resolveModel("haiku").outputTokenEstimate, 2000);
    assert.equal(resolveModel("opus").outputTokenEstimate, 2000);
  });

  test("keeps the OpenAI rows a ceiling over what the pinned effort spends", () => {
    // The property, not the number: a row's estimate is documented as a ceiling,
    // and `outputTokenEstimate` is a property of the model *and* the pinned
    // effort together. At the pinned high effort a whole book spent 167,647
    // output tokens over 47 calls — 3,567 per call — so a row below that has
    // stopped being a gate. Asserting the invariant rather than the constant
    // leaves headroom free to change and under-quoting caught.
    assert.ok(resolveModel("luna").outputTokenEstimate >= OPENAI_MEASURED_OUTPUT_PER_CALL);
    assert.ok(resolveModel("terra").outputTokenEstimate >= OPENAI_MEASURED_OUTPUT_PER_CALL);
  });

  test("rejects unknown models with the accepted list", () => {
    // gpt-5.6-sol is a real model deliberately left out of the registry, so it
    // also proves the gate is an allowlist rather than a vendor-prefix check.
    assert.throws(() => resolveModel("gpt-5.6-sol"), /Unknown model "gpt-5\.6-sol"\. Accepted:/);
  });

  test("DEFAULT_MODEL is a resolvable ID", () => {
    assert.equal(resolveModel(DEFAULT_MODEL).id, DEFAULT_MODEL);
  });

  test("defaults to Luna, on the OpenAI row a no-flag run needs a key for", () => {
    // A price decision, not a quality finding (ADR-0009). The provider half is
    // the one with teeth: the default moving vendors is what changed which
    // credential a no-flag run demands, so it is asserted rather than implied.
    const model = resolveModel(DEFAULT_MODEL);
    assert.equal(model.id, "gpt-5.6-luna");
    assert.equal(model.provider, "openai");
  });

  test("keeps Sonnet a resolvable non-default after the default moved", () => {
    // ADR-0009 expects to be re-measured and possibly reversed, so switching
    // back has to stay one flag. Nothing left the allowlist when the default
    // did — asserted as "reachable and not the default", which is the state a
    // botched reversal or a tidied-up allowlist would break.
    assert.equal(resolveModel("claude-sonnet-5").id, "claude-sonnet-5");
    assert.notEqual(resolveModel("sonnet").id, DEFAULT_MODEL);
  });
});
