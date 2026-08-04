# Luna is the default extraction model

Supersedes [ADR-0004](0004-sonnet-is-the-default-extraction-model.md).

A no-flag extraction run uses `gpt-5.6-luna`. Sonnet keeps its registry row, its
shorthand and its full ID; nothing was removed from the allowlist, and switching
back is `--model sonnet`.

**This is a price decision with an open quality question, not a quality
finding.** Read the two halves below in that order, because the second one is
the reason this ADR expects to be revisited.

## The price advantage is large, certain, and independent of quality

Sonnet lists at $3/$15 per million tokens; Luna lists at $0.20/$1.20. That is
12–15× on the rates alone, and it does not depend on how either model behaves.

Measured on The Potter's Path, whole-book runs (ADR-0008 has the full table):

| run | cost |
|---|---|
| Sonnet | $3.95 |
| Luna at the pinned high effort | $0.25 |

The effect that matters is not the $3.70. It is that re-running a whole book
after a prompt change stops being a decision worth deliberating over. The
pipeline's cost guidance has always been "probe one chapter, then one book,
then a batch" precisely because a book was several dollars; at a quarter, the
probe stops being the only affordable way to ask a question of a whole book.

Luna's reasoning tokens bill as output at $1.20/MTok and erode exactly this
margin, which is why the effort pin is not a free dial (ADR-0008). The $0.25
above is the pinned-high figure, so the margin quoted here is the one that
survives the pin.

## The quality comparison behind this is contaminated

Every Sonnet-versus-Luna measurement to date was taken *before* the
character-inclusion rule was defined. Neither model was being judged against a
stated definition of what counts as a character, so "how many characters did it
find" was being compared across two models that were each answering a question
nobody had written down.

What that leaves:

- **The Sonnet baseline is not stable across books.** 67 characters on The
  Potter's Path against 143 on Pale Lights. Whatever that spread is measuring,
  it is not a property of a model that a per-book count can be compared against.
- **Sonnet misses characters Luna catches.** Sonnet dropped `Aldric`, a named
  supporting character, that Luna extracted. One observation, not a rate.
- **Both models split one person across several entries.** Sonnet produced
  `Marcus` / `Marcus the apprentice` / `Marcus Ashford`; Luna at high effort
  splits `Greaves` into `Blacksmith next door` and `Greaves` (ADR-0008). The
  frequency is unquantified on both sides, so neither is known to be worse.

So the honest statement of the position is: the two models are not known to
differ in quality in either direction, and the numbers that look like quality
evidence were produced under conditions that cannot support the comparison. The
switch is being made because the price difference is real and the quality
difference is unmeasured — not because Luna was found to be as good, and
certainly not because it was found to be better.

ADR-0004's own finding is not contradicted by any of this. It found that the
cheap-model failure mode on this task is roster noise — walk-ons promoted,
one person fragmented — and that finding still stands; Luna exhibits the
fragmentation half of it at the pinned effort. What changed is not the finding
but the price of buying past it.

## This ADR is built to be reversed

The most likely future event is a re-measurement of both models under the
character-inclusion rule that answers the question this ADR had to leave open,
and it may well answer it against Luna. That should be a routine correction, so
the change is kept to the size of one:

- **One constant, in code.** `DEFAULT_MODEL` in `src/models.ts`. No caller
  hardcodes a model: the probe derives its default from the same registry, and
  the scaffolding check derives which credential to name from that row's
  provider. Be honest about the rest, though — the prose that cites this
  decision (README, `CLAUDE.md`, the tests' comments, this file) has to move
  with it, and that is more than one edit. What is kept small is the *behaviour*
  change; the documentation sweep is the recurring cost of recording a decision
  in more than one place, and it is paid on the way back as well as the way out.
- **No allowlist churn to undo.** Sonnet's row, rates, shorthand and full ID are
  untouched, and no run's output is invalidated — a chapter extract stamps the
  model that produced it, so what is on disk stays readable and re-priceable
  whichever way the default points.
- **No prompt or schema change rides along with this.** A reversal is a reversal
  of the default and nothing else.

Reversing this is not an embarrassment; it is the measurement arriving. What
would be an error is treating the switch as evidence that the quality question
was settled.

## Considered options

- **Defer the switch until both models are re-measured under the inclusion
  rule.** The stronger objection, and it was raised and passed over: switching
  now enshrines a default on evidence known to be unreliable. It was passed over
  because the price advantage does not depend on the outcome of that
  measurement, and because a 12–15× cost on every book is paid continuously
  while the measurement is pending. The cost of being wrong here is one constant
  and a re-run; the cost of deferring is every book in the meantime.
- **Terra.** The other OpenAI row, at $2/$12. It earns its place as the fallback
  if Luna proves too noisy, not as a saving — on the promotional Sonnet rate it
  is not cheaper than Sonnet at all. Not a default.
- **Haiku.** ADR-0004's rejected cheap option, at $1/$5. Luna is cheaper than
  Haiku on both sides of the meter, so the cheap-Anthropic-row question is now
  moot rather than reopened.

## Consequences

**A no-flag run now requires an OpenAI credential.** `OPENAI_API_KEY` rather
than `ANTHROPIC_API_KEY`. This needs no new mechanism — the credential check is
provider-derived and already names the specific missing variable (ADR-0008) —
but it is a user-visible behaviour change for anyone who has only ever run the
default, and it is the first thing a fresh clone hits.

**A default-model probe writes to a different directory.** Probe output is keyed
by resolved model, so the default now lands in
`output/{slug}-probe-gpt-5.6-luna/` rather than `…-probe-claude-sonnet-5/`. Any
existing Sonnet probe directory is left where it is and stays comparable by
`compare-extractions`.

**Nothing on disk is invalidated and nothing is re-extracted.** A run's extracts
record the model and the effort that produced them, and the reuse guard is
per-directory, so an existing Sonnet book neither breaks nor silently mixes with
a Luna one — attempting that fails closed, as it did before (ADR-0008).

**The cost-awareness guidance changes shape, not direction.** Probing one
chapter before a book is still the right habit, but it is now about whether the
output is right rather than about whether the run is affordable.
