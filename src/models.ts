// Model registry for stage-3 extraction (extract-chapter / extract-book).
//
// The registry doubles as an allowlist: --model must resolve to an entry here,
// so the cost gate can never price an unknown model and a typo can't reach the
// paid API. To support a new Anthropic model, add a row *with its price* — the
// per-model rates keep the cost estimate and the manifest honest.

export interface ModelRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ModelInfo {
  id: string;
  rates: ModelRates;
}

// Standard list prices (USD per million tokens). Sonnet is kept at $3/$15 —
// the pipeline's prior hardcoded rate — rather than the promotional $2/$10:
// for a cost *gate*, over-estimating is the safe direction, and it keeps a
// no-flag run's estimate byte-identical to before this flag existed.
const REGISTRY: Record<string, ModelRates> = {
  "claude-sonnet-5": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  "claude-opus-4-8": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
};

// Friendly shorthands so `--model haiku` works without the full ID.
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-8",
};

export const DEFAULT_MODEL = "claude-sonnet-5";

// Resolve a --model value (alias or full ID) to a priced model. Throws with the
// accepted names if it isn't in the registry, so an unpriced/misspelled model
// is rejected before any API call. Idempotent on an already-resolved ID.
export function resolveModel(value: string): ModelInfo {
  const id = ALIASES[value] ?? value;
  const rates = REGISTRY[id];
  if (!rates) {
    const accepted = [...Object.keys(ALIASES), ...Object.keys(REGISTRY)].join(", ");
    throw new Error(`Unknown model "${value}". Accepted: ${accepted}`);
  }
  return { id, rates };
}
