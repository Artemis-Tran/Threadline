import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  callExtraction,
  apiErrorMessage,
  apiKeyEnvVar,
  AnthropicExtractionClient,
  OpenAIExtractionClient,
} from "../src/extraction-call";

// The seam is tested by injection: a fake client captures the request that was
// built and returns a canned vendor-shaped payload. Nothing here reaches a live
// API, so the whole file runs offline and spends nothing.
type AnthropicCreate = AnthropicExtractionClient["messages"]["create"];
type CannedResponse = Awaited<ReturnType<AnthropicCreate>>;
type CapturedRequest = Parameters<AnthropicCreate>[0];

function fakeClient(response: CannedResponse): { client: AnthropicExtractionClient; calls: CapturedRequest[] } {
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
  provider: "anthropic" as const,
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

  test("normalises Anthropic's thinking-token detail into the reasoning count", async () => {
    const { client } = fakeClient(
      response({ usage: { ...USAGE, output_tokens_details: { thinking_tokens: 214 } } })
    );
    const result = await callExtraction(REQUEST, client);

    assert.equal(result.usage.reasoningTokens, 214);
    // The billed totals are untouched: the detail decomposes output_tokens,
    // it does not add to it.
    assert.equal(result.usage.outputTokens, 340);
  });

  test("leaves the reasoning count absent — not zero — when the detail is missing", async () => {
    for (const usage of [USAGE, { ...USAGE, output_tokens_details: null }]) {
      const { client } = fakeClient(response({ usage }));
      const result = await callExtraction(REQUEST, client);

      // Absent rather than 0: "the vendor didn't report it" and "the model
      // reasoned for nothing" are different facts, and the effort decision
      // ADR-0008 defers to a probe turns on telling them apart.
      assert.equal("reasoningTokens" in result.usage, false);
    }
  });

  test("keeps a genuine zero, which is a measurement rather than a silence", async () => {
    const { client } = fakeClient(
      response({ usage: { ...USAGE, output_tokens_details: { thinking_tokens: 0 } } })
    );
    assert.equal((await callExtraction(REQUEST, client)).usage.reasoningTokens, 0);
  });
});

// --- OpenAI ---------------------------------------------------------------
//
// Luna is the canonical OpenAI fixture throughout: it is the row this work is
// aimed at. Terra gets one case, proving it takes the same branch rather than
// re-asserting everything Luna already pins.

type OpenAICreate = OpenAIExtractionClient["responses"]["create"];
type CannedOpenAIResponse = Awaited<ReturnType<OpenAICreate>>;
type CapturedOpenAIRequest = Parameters<OpenAICreate>[0];

function fakeOpenAIClient(response: CannedOpenAIResponse): {
  client: OpenAIExtractionClient;
  calls: CapturedOpenAIRequest[];
} {
  const calls: CapturedOpenAIRequest[] = [];
  return {
    calls,
    client: {
      responses: {
        async create(body) {
          calls.push(body);
          return response;
        },
      },
    },
  };
}

function openAIResponse(overrides: Partial<CannedOpenAIResponse> = {}): CannedOpenAIResponse {
  return {
    model: "gpt-5.6-luna",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: '{"characters":[]}' }] },
    ],
    usage: USAGE,
    ...overrides,
  };
}

const OPENAI_REQUEST = {
  ...REQUEST,
  model: "gpt-5.6-luna",
  provider: "openai" as const,
};

describe("callExtraction OpenAI request shaping", () => {
  test("builds the OpenAI structured-output request with strict mode on", async () => {
    const { client, calls } = fakeOpenAIClient(openAIResponse());
    await callExtraction(OPENAI_REQUEST, client);

    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.equal(sent.model, "gpt-5.6-luna");
    assert.equal(sent.instructions, "You are extracting structured story data.");
    assert.equal(sent.input, "Once upon a time.");

    const format = sent.text?.format;
    assert.equal(format?.type, "json_schema");
    assert.equal(format?.type === "json_schema" && format.strict, true);
    // Strict mode requires a schema name; the vendor rejects the request without one.
    assert.ok(format?.type === "json_schema" && format.name.length > 0);
  });

  test("sends the output budget under OpenAI's parameter name", async () => {
    const { client, calls } = fakeOpenAIClient(openAIResponse());
    await callExtraction(OPENAI_REQUEST, client);

    assert.equal(calls[0].max_output_tokens, 16000);
    // Anthropic's name must not leak across.
    assert.equal((calls[0] as Record<string, unknown>).max_tokens, undefined);
  });

  test("pins reasoning effort rather than leaving it unset", async () => {
    // Pinned, not defaulted: reasoning tokens bill as output and share the
    // answer's budget, so the effort has to be a decision the registry's output
    // estimate is sized against. Low is the measured winner — medium spent 382
    // reasoning tokens for an identical character set — and pinning it still
    // matters even though the value now differs from the vendor's default.
    const { client, calls } = fakeOpenAIClient(openAIResponse());
    await callExtraction(OPENAI_REQUEST, client);

    assert.equal(calls[0].reasoning?.effort, "low");
  });

  test("passes the same schema object both vendors get, unmodified", async () => {
    const { client, calls } = fakeOpenAIClient(openAIResponse());
    await callExtraction(OPENAI_REQUEST, client);

    const format = calls[0].text?.format;
    assert.equal(format?.type === "json_schema" && format.schema, SCHEMA);
  });

  test("Terra takes the same branch as Luna", async () => {
    const { client, calls } = fakeOpenAIClient(openAIResponse({ model: "gpt-5.6-terra" }));
    const result = await callExtraction({ ...OPENAI_REQUEST, model: "gpt-5.6-terra" }, client);

    assert.equal(calls[0].model, "gpt-5.6-terra");
    assert.equal(calls[0].text?.format?.type, "json_schema");
    assert.equal(result.stopReason, "ok");
  });
});

describe("callExtraction OpenAI response normalisation", () => {
  test("returns the text, the served model, and the two token counts", async () => {
    const { client } = fakeOpenAIClient(openAIResponse({ model: "gpt-5.6-luna-2026-07-01" }));
    const result = await callExtraction(OPENAI_REQUEST, client);

    assert.equal(result.text, '{"characters":[]}');
    assert.equal(result.modelReturned, "gpt-5.6-luna-2026-07-01");
    assert.equal(result.stopReason, "ok");
    // Same neutral shape a Sonnet extract gets, so a chapter extract from
    // either vendor is indistinguishable.
    assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 340 });
  });

  test("maps a refusal content part to the same stop reason as an Anthropic refusal", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
      })
    );
    const result = await callExtraction(OPENAI_REQUEST, client);

    assert.equal(result.stopReason, "refusal");
    // Nothing usable to write, and the caller writes no extract for a refusal.
    assert.equal(result.text, "");
  });

  test("maps an incomplete status to truncation and keeps the partial text", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: '{"characters":[{"na' }] }],
      })
    );
    const result = await callExtraction(OPENAI_REQUEST, client);

    assert.equal(result.stopReason, "max_tokens");
    assert.equal(result.text, '{"characters":[{"na');
  });

  test("maps an incomplete content filter to a refusal, not to truncation", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] })
    );
    assert.equal((await callExtraction(OPENAI_REQUEST, client)).stopReason, "refusal");
  });

  test("maps a failed or in-progress status to \"other\"", async () => {
    const { client: failed } = fakeOpenAIClient(openAIResponse({ status: "failed", output: [] }));
    assert.equal((await callExtraction(OPENAI_REQUEST, failed)).stopReason, "other");

    const { client: inProgress } = fakeOpenAIClient(openAIResponse({ status: "in_progress" }));
    assert.equal((await callExtraction(OPENAI_REQUEST, inProgress)).stopReason, "other");
  });

  test("takes the output text past a reasoning item that precedes it", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", content: [{ type: "output_text", text: '{"events":[]}' }] },
        ],
      })
    );
    assert.equal((await callExtraction(OPENAI_REQUEST, client)).text, '{"events":[]}');
  });

  test("reports zero tokens rather than throwing when usage is absent", async () => {
    const { client } = fakeOpenAIClient(openAIResponse({ usage: undefined }));
    // Zero is the right answer for the billed counts — nothing was reported, so
    // nothing is added to a total — but not for the reasoning split, which stays
    // absent rather than claiming a measurement that was never made.
    assert.deepEqual((await callExtraction(OPENAI_REQUEST, client)).usage, {
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test("normalises OpenAI's reasoning-token detail to the same field Anthropic's lands in", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({ usage: { ...USAGE, output_tokens_details: { reasoning_tokens: 896 } } })
    );
    const result = await callExtraction(OPENAI_REQUEST, client);

    assert.equal(result.usage.reasoningTokens, 896);
    assert.equal(result.usage.outputTokens, 340);
  });

  test("leaves the reasoning count absent when the detail is missing", async () => {
    const { client } = fakeOpenAIClient(openAIResponse());
    assert.equal("reasoningTokens" in (await callExtraction(OPENAI_REQUEST, client)).usage, false);
  });

  // Not hypothetical: at low reasoning effort GPT-5.6 reports exactly this, and
  // the probe that settled the effort question read a zero here as the evidence
  // that no deliberation happened. Collapsing it to "absent" would have thrown
  // that answer away.
  test("keeps a genuine zero, which is a measurement rather than a silence", async () => {
    const { client } = fakeOpenAIClient(
      openAIResponse({ usage: { ...USAGE, output_tokens_details: { reasoning_tokens: 0 } } })
    );
    assert.equal((await callExtraction(OPENAI_REQUEST, client)).usage.reasoningTokens, 0);
  });
});

describe("apiKeyEnvVar", () => {
  test("names the variable each provider needs", () => {
    assert.equal(apiKeyEnvVar("anthropic"), "ANTHROPIC_API_KEY");
    assert.equal(apiKeyEnvVar("openai"), "OPENAI_API_KEY");
  });
});

describe("apiErrorMessage", () => {
  test("reports an Anthropic API failure", () => {
    const err = new Anthropic.APIError(429, undefined, "rate limited", undefined);
    assert.match(apiErrorMessage(err) ?? "", /Anthropic API error 429: .*rate limited/);
  });

  test("reports an OpenAI API failure rather than falling through", () => {
    const err = new OpenAI.APIError(500, undefined, "server had a problem", undefined);
    assert.match(apiErrorMessage(err) ?? "", /OpenAI API error 500: .*server had a problem/);
  });

  test("returns null for anything that is not a vendor API error", () => {
    assert.equal(apiErrorMessage(new Error("ENOENT: no such file")), null);
  });
});
