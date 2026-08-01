// The extraction call seam. Callers hand in a resolved extraction model, a
// system prompt, chapter text, a JSON schema, and an output budget, and get back
// a normalised ExtractionResult, without knowing which vendor served it.
//
// Stage 2 (extract-chapter) calls through here. Stage 3 (extract-book) still has
// its own Anthropic call path and is deliberately left alone for now — wiring it
// up is separate work, gated on real output from a second provider first.
//
// The seam reports what happened; it does not decide how to report it. Refusals,
// truncation, and unparseable output are all ordinary results here — the calling
// command owns presentation, because stage 2 dumps raw text and sets an exit
// code while stage 3 throws for its caller to persist a partial manifest.

import Anthropic from "@anthropic-ai/sdk";

// Normalised across vendors: "ok" is a complete response, "refusal" and
// "max_tokens" are the two failures worth distinguishing, and "other" is
// everything a caller can only treat as "no usable output".
export type ExtractionStopReason = "ok" | "refusal" | "max_tokens" | "other";

export interface ExtractionResult {
  text: string;
  // The model string the vendor said it served, kept separate from the
  // requested registry ID so a silently re-pointed alias stays visible.
  modelReturned: string;
  stopReason: ExtractionStopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtractionRequest {
  // A resolved registry ID (see ./models) — never a shorthand.
  model: string;
  systemPrompt: string;
  chapterText: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

// The slice of an Anthropic message this module actually reads. Declared
// structurally rather than as Anthropic.Message so a test can hand in a canned
// payload without constructing every field the SDK type requires; a real client
// remains assignable because its response is a superset of this.
interface AnthropicResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ExtractionClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<AnthropicResponse>;
  };
}

function normaliseStopReason(stopReason: string | null): ExtractionStopReason {
  switch (stopReason) {
    case "end_turn":
      return "ok";
    case "refusal":
      return "refusal";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

// `client` is optional so tests can drive the real composition with a fake,
// mirroring how stage 3's per-chapter processing already receives its client.
// A live run passes nothing and gets a real SDK client.
export async function callExtraction(
  request: ExtractionRequest,
  client?: ExtractionClient
): Promise<ExtractionResult> {
  const anthropic: ExtractionClient = client ?? new Anthropic();

  const response = await anthropic.messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.systemPrompt,
    output_config: {
      format: { type: "json_schema", schema: request.schema },
    },
    messages: [{ role: "user", content: request.chapterText }],
  });

  // A response with no text block (a refusal, or a stop reason that carries no
  // content) yields empty text rather than a special case — the stop reason is
  // what tells the caller which failure it is looking at.
  const textBlock = response.content.find((b) => b.type === "text");

  return {
    text: textBlock?.text ?? "",
    modelReturned: response.model,
    stopReason: normaliseStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
