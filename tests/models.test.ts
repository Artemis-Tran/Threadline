import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, DEFAULT_MODEL } from "../src/models";

describe("resolveModel", () => {
  test("resolves friendly aliases to full IDs", () => {
    assert.equal(resolveModel("sonnet").id, "claude-sonnet-5");
    assert.equal(resolveModel("haiku").id, "claude-haiku-4-5");
    assert.equal(resolveModel("opus").id, "claude-opus-4-8");
  });

  test("is idempotent on an already-resolved ID", () => {
    assert.equal(resolveModel("claude-haiku-4-5").id, "claude-haiku-4-5");
  });

  test("carries per-model rates", () => {
    assert.deepEqual(resolveModel("haiku").rates, { inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
    assert.deepEqual(resolveModel("sonnet").rates, { inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
  });

  test("rejects unknown models with the accepted list", () => {
    assert.throws(() => resolveModel("gpt-5"), /Unknown model "gpt-5"\. Accepted:/);
  });

  test("DEFAULT_MODEL is a resolvable ID", () => {
    assert.equal(resolveModel(DEFAULT_MODEL).id, DEFAULT_MODEL);
  });
});
