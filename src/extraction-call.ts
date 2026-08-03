// The extraction call seam. Callers hand in a resolved extraction model, a
// system prompt, chapter text, a JSON schema, and an output budget, and get back
// a normalised ExtractionResult, without knowing which vendor served it.
//
// extract-book calls through here, and it is the only extraction path there is
// — the single-chapter probe forwards to it. So every extraction the pipeline
// performs, on either vendor, is made by this file (ADR-0008).
//
// The seam reports what happened; it does not decide how to report it. Refusals,
// truncation, and unparseable output are all ordinary results here — the calling
// command owns presentation, because one caller may want to dump raw text and
// set an exit code where another throws so its caller can persist a partial
// manifest.
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

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  // How many of `outputTokens` went on internal reasoning rather than on the
  // answer. It decomposes the output count rather than adding to it, so cost
  // arithmetic never touches this field.
  //
  // Absent, never zero, when the vendor didn't report the detail. "Nothing was
  // measured" and "the model reasoned for nothing" are different facts, and the
  // medium-versus-low effort question was settled by exactly this number — low
  // reported a real zero here, which a zero standing in for silence would have
  // been indistinguishable from.
  reasoningTokens?: number;
}

export interface ExtractionResult {
  text: string;
  // The model string the vendor said it served, kept separate from the
  // requested registry ID so a silently re-pointed alias stays visible.
  modelReturned: string;
  stopReason: ExtractionStopReason;
  usage: ExtractionUsage;
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
  usage: AnthropicUsage & { input_tokens: number; output_tokens: number };
}

// Just enough of an Anthropic usage payload to find the thinking split. Both
// members are wider here than in the SDK — which declares the details object
// required-but-nullable and `thinking_tokens` required — so that a test double,
// or a vendor response predating the field, can leave either out. A real
// payload stays assignable because it only ever narrows this.
export interface AnthropicUsage {
  output_tokens_details?: { thinking_tokens?: number } | null;
}

// The same trick for an OpenAI response. The optional fields are optional in
// the SDK's own type too, so a real client stays assignable — which is why
// usage has to be read defensively below.
interface OpenAIResponse {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  };
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

// GPT-5.6 takes none/low/medium/high/xhigh/max (the family dropped "minimal").
// The family defaults to medium; we pin low, so the pin is now load-bearing
// rather than a restatement of the default.
//
// Low won a one-chapter probe against medium and is now known to have won it on
// a chapter that could not test the thing at issue. That probe ran chapter 1,
// which has an empty roster and nine unambiguous characters, so there was no
// identity judgment to make and an identical character set at both efforts was
// the only available outcome.
//
// Whole-book runs since say the opposite. At low, Luna collapses distinct
// characters into one entry — Pelham absorbed into Davos Merrick, a one-scene
// customer absorbed into Lydia the baker — and the roster then carries the bad
// alias forward into every later chapter. High eliminates both for about $0.13
// more per book. Max matches high exactly and costs four times as much, so the
// scale saturates above high.
//
// Low stays pinned anyway, for now: raising it is a cost change to every future
// Luna run, and no effort makes Luna clean — high and max split one character
// across two entries where low merges two into one. Sonnet does neither and is
// still the default (ADR-0004). Do not re-litigate this from the chapter-1
// numbers; see ADR-0008 for what has actually been measured.
//
// Still a constant and not a flag: reasoning tokens bill as output and spend the
// same budget the answer needs, so effort has to be a level the registry's
// output estimate is sized against rather than something a run can move out from
// under the cost gate (ADR-0008).
const OPENAI_REASONING_EFFORT = "low";

// What effort a run on this provider is pinned to, or null where the vendor has
// no such concept. Exported because the pin is a constant rather than a flag, so
// the request body is otherwise the only place the effort exists and nothing on
// disk would say which effort produced an extract. Two runs of the same book at
// different efforts are indistinguishable without this, which is a real hazard
// once more than one exists.
//
// Null, not a default string, for Anthropic: it keeps the field off every
// Anthropic extract rather than stamping a level that means nothing there.
export function reasoningEffort(provider: Provider): string | null {
  return provider === "openai" ? OPENAI_REASONING_EFFORT : null;
}

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

// One concept under two vendor names — Anthropic reports it as thinking tokens,
// OpenAI as reasoning tokens — which is exactly the kind of thing this seam
// exists to flatten, rather than an OpenAI concern leaking across it.
//
// Private, like its OpenAI twin. It was exported while extract-book built its
// own Anthropic request and had to know the vendor's field name; that caller is
// gone, and both spellings are pinned through callExtraction instead.
function anthropicReasoningTokens(usage: AnthropicUsage): number | undefined {
  return asTokenCount(usage.output_tokens_details?.thinking_tokens);
}

function openAIReasoningTokens(usage: OpenAIResponse["usage"]): number | undefined {
  return asTokenCount(usage?.output_tokens_details?.reasoning_tokens);
}

// Anything that isn't a number — an omitted detail object, an explicit null, a
// field a later SDK spells differently — is "not reported", which is undefined
// and not zero. See ExtractionUsage.reasoningTokens for why that matters.
function asTokenCount(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
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

  const reasoningTokens = anthropicReasoningTokens(response.usage);

  return {
    text: textBlock?.text ?? "",
    modelReturned: response.model,
    stopReason: normaliseAnthropicStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
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

  const reasoningTokens = openAIReasoningTokens(response.usage);

  return {
    text: textPart?.text ?? "",
    modelReturned: response.model,
    stopReason: normaliseOpenAIStopReason(response, refused),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    },
  };
}

// `client` is optional so tests can drive the real composition with a fake,
// mirroring how extract-book's per-chapter processing already receives its
// client.
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
