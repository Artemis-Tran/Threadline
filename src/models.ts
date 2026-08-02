// Model registry for extraction (extract-chapter / extract-book).
//
// The registry doubles as an allowlist: --model must resolve to an entry here,
// so the cost gate can never price an unknown model and a typo can't reach the
// paid API. To support a new model, add a row *with its price* — the per-model
// rates keep the cost estimate and the manifest honest.
//
// The registry is also the authority on which vendor serves a model. `provider`
// is stated on the row rather than sniffed from an ID prefix: the registry
// already exists to be the authoritative list, and prefix-matching would create
// a second, weaker source of truth that disagrees with it the day a vendor
// renames something.

export type Provider = "anthropic" | "openai";

export interface ModelRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ModelInfo {
  id: string;
  provider: Provider;
  rates: ModelRates;
  // Per-chapter output tokens the cost gate should assume. Over-estimating is
  // the safe direction for a gate, so a row's number is a ceiling, not a mean.
  outputTokenEstimate: number;
}

interface ModelRow {
  provider: Provider;
  rates: ModelRates;
  outputTokenEstimate: number;
}

// Standard list prices (USD per million tokens). Sonnet is kept at $3/$15 —
// the pipeline's prior hardcoded rate — rather than the promotional $2/$10:
// for a cost *gate*, over-estimating is the safe direction, and it keeps a
// no-flag run's estimate byte-identical to before this flag existed. That also
// means Terra is not cheaper than Sonnet on the promotional rate; it earns its
// row as the fallback if Luna proves too noisy, not as a saving.
//
// The Anthropic rows carry 2000 output tokens because that is the figure the
// extract step's gate hardcoded before this field existed.
//
// The OpenAI rows carry 1290, measured. They previously carried a guessed 12000
// on the reasoning that GPT-5.6 is a reasoning family whose reasoning tokens
// bill as output, so the reasoning spend would dwarf the answer; a live chapter
// says otherwise, and 12000 over-quoted that chapter 7.5× ($0.015373 against
// $0.002039 actual). The probe ran the same chapter at both efforts and 1290 is
// the higher of the two runs — medium's, against low's 1054 — because the row is
// a ceiling and not a mean, even though the seam now pins low. The vendor's
// reported output count already includes reasoning tokens, so that total is the
// whole of what the gate has to cover.
//
// This is why 1290 must not be re-derived from a low-effort run alone: the
// margin over what low actually spends is deliberate headroom, not slack.
//
// It is a ceiling across *effort*, not across chapter length — one 1358-word
// chapter measured, against a ~1937-word book average — so a long chapter can
// out-spend it. A whole-run quote absorbs that across chapters; a one-chapter
// probe of a long chapter is where it shows. More chapters is the only fix
// (ADR-0008).
const REGISTRY: Record<string, ModelRow> = {
  "claude-sonnet-5": {
    provider: "anthropic",
    rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    outputTokenEstimate: 2000,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    rates: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    outputTokenEstimate: 2000,
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    rates: { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    outputTokenEstimate: 2000,
  },
  "gpt-5.6-luna": {
    provider: "openai",
    rates: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 },
    outputTokenEstimate: 1290,
  },
  "gpt-5.6-terra": {
    provider: "openai",
    rates: { inputUsdPerMTok: 2, outputUsdPerMTok: 12 },
    outputTokenEstimate: 1290,
  },
};

// Friendly shorthands so `--model haiku` works without the full ID.
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-8",
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
};

export const DEFAULT_MODEL = "claude-sonnet-5";

// Resolve a --model value (alias or full ID) to a priced model. Throws with the
// accepted names if it isn't in the registry, so an unpriced/misspelled model
// is rejected before any API call. Idempotent on an already-resolved ID.
export function resolveModel(value: string): ModelInfo {
  const id = ALIASES[value] ?? value;
  const row = REGISTRY[id];
  if (!row) {
    const accepted = [...Object.keys(ALIASES), ...Object.keys(REGISTRY)].join(", ");
    throw new Error(`Unknown model "${value}". Accepted: ${accepted}`);
  }
  return { id, ...row };
}
