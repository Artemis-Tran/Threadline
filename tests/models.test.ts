import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, DEFAULT_MODEL } from "../src/models";

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
    // Pinned for the Anthropic rows because the stage-3 gate used to hardcode
    // 2000 — a no-flag estimate has to come out unchanged.
    assert.equal(resolveModel("sonnet").outputTokenEstimate, 2000);
    assert.equal(resolveModel("haiku").outputTokenEstimate, 2000);
    assert.equal(resolveModel("opus").outputTokenEstimate, 2000);
  });

  test("prices the OpenAI rows from the probe's higher run", () => {
    // 1290 output tokens is the medium-effort run of the Luna probe, taken over
    // low's 1054 to keep the row a ceiling rather than a mean. It replaces an
    // unmeasured 12000 that over-quoted the probed chapter 7.5×.
    assert.equal(resolveModel("luna").outputTokenEstimate, 1290);
    assert.equal(resolveModel("terra").outputTokenEstimate, 1290);
  });

  test("rejects unknown models with the accepted list", () => {
    // gpt-5.6-sol is a real model deliberately left out of the registry, so it
    // also proves the gate is an allowlist rather than a vendor-prefix check.
    assert.throws(() => resolveModel("gpt-5.6-sol"), /Unknown model "gpt-5\.6-sol"\. Accepted:/);
  });

  test("DEFAULT_MODEL is a resolvable ID", () => {
    assert.equal(resolveModel(DEFAULT_MODEL).id, DEFAULT_MODEL);
  });
});
