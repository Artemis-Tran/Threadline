import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { callExtraction, ExtractionClient } from "../src/extraction-call";

// The seam is tested by injection: a fake client captures the request that was
// built and returns a canned vendor-shaped payload. Nothing here reaches a live
// API, so the whole file runs offline and spends nothing.
type CannedResponse = Awaited<ReturnType<ExtractionClient["messages"]["create"]>>;
type CapturedRequest = Parameters<ExtractionClient["messages"]["create"]>[0];

function fakeClient(response: CannedResponse): { client: ExtractionClient; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    client: {
      messages: {
        async create(body) {
          calls.push(body);
          return response;
        },
      },
    },
  };
}

const USAGE = { input_tokens: 1200, output_tokens: 340 };

function response(overrides: Partial<CannedResponse> = {}): CannedResponse {
  return {
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"characters":[]}' }],
    usage: USAGE,
    ...overrides,
  };
}

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const REQUEST = {
  model: "claude-sonnet-5",
  systemPrompt: "You are extracting structured story data.",
  chapterText: "Once upon a time.",
  schema: SCHEMA,
  maxTokens: 16000,
};

describe("callExtraction request shaping", () => {
  test("builds the Anthropic structured-output request from the neutral request", async () => {
    const { client, calls } = fakeClient(response());
    await callExtraction(REQUEST, client);

    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.equal(sent.model, "claude-sonnet-5");
    assert.equal(sent.max_tokens, 16000);
    assert.equal(sent.system, "You are extracting structured story data.");
    assert.deepEqual(sent.messages, [{ role: "user", content: "Once upon a time." }]);
    assert.equal(sent.output_config?.format?.type, "json_schema");
  });

  test("passes the caller's schema object through unmodified", async () => {
    const { client, calls } = fakeClient(response());
    await callExtraction(REQUEST, client);

    const format = calls[0].output_config?.format;
    assert.equal(format?.type === "json_schema" && format.schema, SCHEMA);
  });
});

describe("callExtraction response normalisation", () => {
  test("returns the text, the served model, and the two token counts", async () => {
    const { client } = fakeClient(response({ model: "claude-sonnet-5-20260101" }));
    const result = await callExtraction(REQUEST, client);

    assert.equal(result.text, '{"characters":[]}');
    assert.equal(result.modelReturned, "claude-sonnet-5-20260101");
    assert.equal(result.stopReason, "ok");
    assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 340 });
  });

  test("maps a refusal stop reason", async () => {
    const { client } = fakeClient(response({ stop_reason: "refusal", content: [] }));
    assert.equal((await callExtraction(REQUEST, client)).stopReason, "refusal");
  });

  test("maps truncation and keeps the partial text for the caller to dump", async () => {
    const { client } = fakeClient(
      response({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"characters":[{"na' }] })
    );
    const result = await callExtraction(REQUEST, client);

    assert.equal(result.stopReason, "max_tokens");
    assert.equal(result.text, '{"characters":[{"na');
  });

  test("maps any other stop reason — including a null one — to \"other\"", async () => {
    const { client: toolUse } = fakeClient(response({ stop_reason: "tool_use" }));
    assert.equal((await callExtraction(REQUEST, toolUse)).stopReason, "other");

    const { client: none } = fakeClient(response({ stop_reason: null }));
    assert.equal((await callExtraction(REQUEST, none)).stopReason, "other");
  });

  test("reports empty text when the response carries no text block", async () => {
    const { client } = fakeClient(response({ content: [{ type: "thinking" }] }));
    assert.equal((await callExtraction(REQUEST, client)).text, "");
  });

  test("takes the text block even when a non-text block precedes it", async () => {
    const { client } = fakeClient(
      response({ content: [{ type: "thinking" }, { type: "text", text: '{"events":[]}' }] })
    );
    assert.equal((await callExtraction(REQUEST, client)).text, '{"events":[]}');
  });
});
