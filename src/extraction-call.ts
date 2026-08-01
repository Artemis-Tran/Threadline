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
//
// Everything vendor-specific stops at this file: the SDK clients, the two
// request shapes, the two vocabularies for "it went wrong", and the error
// classes. A caller that imports an SDK to interpret a result has crossed the
// seam and should be given a helper here instead.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Provider } from "./models";

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
  // Which vendor serves that ID, taken from the registry row rather than
  // sniffed from the ID here.
  provider: Provider;
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

// The same trick for an OpenAI response. The optional fields are optional in
// the SDK's own type too, so a real client stays assignable — which is why
// usage has to be read defensively below.
interface OpenAIResponse {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface AnthropicExtractionClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<AnthropicResponse>;
  };
}

export interface OpenAIExtractionClient {
  responses: {
    create(body: OpenAI.Responses.ResponseCreateParamsNonStreaming): Promise<OpenAIResponse>;
  };
}

export type ExtractionClient = AnthropicExtractionClient | OpenAIExtractionClient;

// Strict mode requires the schema be named; the name is not otherwise used.
const OPENAI_SCHEMA_NAME = "chapter_extraction";

// GPT-5.6 takes none/low/medium/high/xhigh/max (the family dropped "minimal")
// and defaults to medium, which is what we pin.
//
// This is a deliberate departure from the ticket, which specified the lowest
// setting on the grounds that extraction is mechanical read-and-structure work.
// The counter-argument won: the established failure mode for a cheap model on
// this task is roster noise — walk-ons promoted to characters, one person split
// across several entries (ADR-0004) — and that is a judgment failure, which
// deliberation is a plausible lever against. Nobody has tested either position,
// and the first Luna probe is what settles it.
//
// The cost is real and is priced in: reasoning tokens bill as output and spend
// the same budget the answer needs, so the registry's output estimate for these
// rows is set high enough to keep the gate a ceiling.
const OPENAI_REASONING_EFFORT = "medium";

const API_KEY_ENV_VARS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

// Which credential a run actually needs. Provider-derived so that running an
// OpenAI model doesn't demand an Anthropic key, or the reverse, and so a caller
// can name the specific missing variable.
export function apiKeyEnvVar(provider: Provider): string {
  return API_KEY_ENV_VARS[provider];
}

// Describes a vendor API failure, or null if the error came from somewhere else.
// Lives here so a caller's top-level handler doesn't have to import both SDKs
// just to tell an API failure from a bug.
export function apiErrorMessage(err: unknown): string | null {
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  if (err instanceof OpenAI.APIError) return `OpenAI API error ${err.status}: ${err.message}`;
  return null;
}

function normaliseAnthropicStopReason(stopReason: string | null): ExtractionStopReason {
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

async function callAnthropic(
  request: ExtractionRequest,
  client?: AnthropicExtractionClient
): Promise<ExtractionResult> {
  const anthropic: AnthropicExtractionClient = client ?? new Anthropic();

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
    stopReason: normaliseAnthropicStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// OpenAI disagrees with Anthropic about how failure arrives: a refusal is a
// content part rather than a stop reason, and truncation is a status with a
// separate reason field. Both have to land on the same normalised reasons, or a
// refusal gets written to disk as though it were an extraction and a truncated
// — but paid for — response gets thrown away as though it were something else.
function normaliseOpenAIStopReason(response: OpenAIResponse, refused: boolean): ExtractionStopReason {
  if (refused) return "refusal";
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return "max_tokens";
      case "content_filter":
        // Filtered rather than truncated: the caller must not dump this as a
        // partial answer or retry it with a bigger budget.
        return "refusal";
      default:
        return "other";
    }
  }
  return response.status === "completed" ? "ok" : "other";
}

async function callOpenAI(
  request: ExtractionRequest,
  client?: OpenAIExtractionClient
): Promise<ExtractionResult> {
  const openai: OpenAIExtractionClient = client ?? new OpenAI();

  const response = await openai.responses.create({
    model: request.model,
    instructions: request.systemPrompt,
    input: request.chapterText,
    max_output_tokens: request.maxTokens,
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    text: {
      format: {
        type: "json_schema",
        name: OPENAI_SCHEMA_NAME,
        schema: request.schema,
        strict: true,
      },
    },
  });

  // Output items interleave — reasoning items precede the message — so both the
  // answer and a refusal are found by scanning parts, not by position.
  const parts = response.output.flatMap((item) => item.content ?? []);
  const textPart = parts.find((p) => p.type === "output_text");
  const refused = parts.some((p) => p.type === "refusal");

  return {
    text: textPart?.text ?? "",
    modelReturned: response.model,
    stopReason: normaliseOpenAIStopReason(response, refused),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}

// `client` is optional so tests can drive the real composition with a fake,
// mirroring how stage 3's per-chapter processing already receives its client.
// A live run passes nothing and gets a real SDK client for the request's
// provider. A caller passing a client is responsible for it matching that
// provider — the cast below is that contract, and both branches are covered by
// tests that inject the right one.
export async function callExtraction(
  request: ExtractionRequest,
  client?: ExtractionClient
): Promise<ExtractionResult> {
  return request.provider === "openai"
    ? callOpenAI(request, client as OpenAIExtractionClient | undefined)
    : callAnthropic(request, client as AnthropicExtractionClient | undefined);
}
