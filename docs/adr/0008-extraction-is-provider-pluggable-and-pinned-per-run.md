# Extraction is provider-pluggable, and a run is pinned to one model

Extraction reaches a vendor through a single call seam,
`src/extraction-call.ts`. It takes a resolved extraction model and returns a
normalised result — text, the served model string, a stop reason, and token
counts — so a caller never learns which vendor answered. Everything
vendor-specific stops there: the SDK clients, the two request shapes, the two
vocabularies for "it went wrong", and the error classes. The model registry is
the authority on which vendor serves a row, stated per row rather than sniffed
from an ID prefix, so the allowlist that already exists does not acquire a
weaker rival.

`extract-book` goes through the seam, and constructs no vendor client of its
own. Since the single-chapter probe was reduced to a translator that forwards to
`extract-book`, that makes the seam the sole extraction path: every call the
pipeline makes, on either vendor, is made there.

This was staged rather than built at once. The seam existed first with no
caller, and `extract-book` rejected a non-Anthropic extraction model up front,
before any charge — wiring it up was deliberately gated on seeing real output
from a second provider. The gate was passed by the single-chapter probe, which
went through the seam while it still had its own call path, and the guard and
its tests are now gone. Going through the seam is what removed it; there was
never a flag to work around it.

Two things changed shape in a chapter extract's `meta` as a consequence, both
because the seam reports normalised results rather than vendor ones. `stopReason`
records the seam's vocabulary (`ok`, `refusal`, `max_tokens`, `other`) rather
than the vendor's own word, so the field means one thing across providers. And
`usage` carries the two billed counts plus the reasoning split, under the
snake_case keys it has always used on disk and that `compare-extractions` reads
to price a run — but no longer the vendor's surrounding fields (cache reads,
service tier), which nothing read.

## One extraction model per run

A run is pinned to exactly one extraction model, and `extract-book` fails
closed if `--model` would reuse chapter extracts written by a different one. It
has to: a
cached extract is loaded verbatim into the roster and never re-extracted, so
mixing would blend two models' output invisibly. The escape hatches are
`--out-dir` for a separate directory and `--force` to re-extract.

The cost of this lands in exactly the situation multi-provider support was
bought for. If a vendor goes down mid-book, the way to finish on the other one
is a fresh output directory and re-paying for every chapter already extracted.
A future reader who hits the reuse guard during an outage will assume it is a
bug; it is not. Every stage checkpointing to disk (ADR-0006) makes a resumed
run cheap *within* one model, and this is the boundary of that guarantee.

## Considered options

- **Mixed-vendor runs** — let one output directory hold chapters from more than
  one vendor. Rejected. It turns a run-level fact into a per-chapter one; it
  normalises the comparison tool's `"mixed"` sentinel, which exists to refuse
  to price a directory rather than to describe a supported mode; and because
  the roster carries earlier chapters' naming into later prompts, it drags one
  vendor's conventions through another's chapters — a quality risk that leaves
  no trace in the output.

## A chapter extract records the requested model, not the served one

A chapter extract stamps the registry ID that was *requested*, and keeps the
vendor's returned string beside it under `modelReturned`. The single-chapter
probe did this while it had its own call path; `extract-book`, now the only
extraction path, does it too.

Stamping the returned string is the obvious thing, and it is what the code did
before OpenAI existed here — so this needs saying, or it will be helpfully
changed back. OpenAI resolves an alias to a dated snapshot in its response.
Stamp that, and the extract records an ID the registry has never heard of:
the reuse guard rejects its own cached extracts on the very next run, and
the comparison tooling cannot price them, because both look the recorded string
up in the registry. The requested ID is the one the registry can price and the
one a resume can match. The served string is worth keeping only so that a
silently re-pointed alias stays visible.

This was previously recorded here as a hazard lying dormant in `extract-book`,
on the reasoning that an Anthropic-only path could not hit it. That reasoning
was wrong, and the correction is worth keeping: Anthropic resolves an alias to a
dated snapshot in its response too. `--model haiku` had already written 47
chapter extracts stamped `claude-haiku-4-5-20251001` beside a manifest carrying
`claude-haiku-4-5`, and because the reuse guard compares the recorded value
against the resolved flag, that directory rejected all 47 of its own cached
extracts — on a normal run and on a `--rebuild-manifest` alike. Paid output that
could be neither resumed against nor rebuilt from. Being one vendor deep is not
what makes this safe; stamping the requested ID is.

`extract-book` now stamps the requested ID, and a one-off migration
(`scripts/migrate-extract-model-stamp.ts`) repaired the extracts already
written. It moved each recorded value to `modelReturned` and wrote the sibling
manifest's registry ID in its place — metadata only, re-extracting nothing — and
no-opped on the two runs whose extracts already carried registry IDs. The
rebuild that had failed on all 47 now succeeds.

The guard itself was not touched, and must not be. Teaching it to accept a dated
suffix by prefix matching would have repaired every directory at once without a
migration, and is the wrong move twice over: it reintroduces exactly the
prefix-sniffing the registry rejects as a second, weaker source of truth about
model identity — in the one place guarding paid output — and it cannot tell a
snapshot apart from a genuinely different model whose ID extends another's.

## Reasoning effort is pinned, at low

The OpenAI rows are called at low reasoning effort. The pinning is the decision,
not the value: reasoning tokens bill as output and spend the same budget the
answer needs, so effort has to be a level the registry's output estimate is
sized against, not whatever a vendor defaults to this quarter. That was worth
saying when the pinned value was also GPT-5.6's default and "drop the parameter,
it's the default anyway" was the available simplification. It is now
load-bearing in the ordinary way, because low is not the default.

Medium was pinned first, and the choice was recorded here as contested and
unmeasured. The case for low was that extraction is mechanical
read-and-structure work that deliberation cannot improve. The case for medium
was that ADR-0004 found the cheap-model failure mode on this task to be roster
noise — walk-ons promoted to characters, one person fragmented across several
entries — a judgment failure rather than a transcription one, and deliberation
is a plausible lever against it.

The Luna probe measured it, one chapter at each effort:

| effort | input | output | reasoning | cost |
|---|---|---|---|---|
| medium | 2455 | 1290 | 382 | $0.002039 |
| low | 2455 | 1054 | 0 | $0.001756 |

Medium spent 382 reasoning tokens for a bit-for-bit identical character set —
same six names, same three walk-on promotions. The roster noise medium was
bought to suppress is present at both efforts in the same amount, so the
argument for it does not survive its own test, and low is pinned. Both efforts
also passed the probe's gating checks: closed vocabularies honoured, and a
roster entry (`"Henry Ashford"`) reused verbatim against a chapter that says
"Henry" 22 times and never "Ashford".

This is one chapter, and it settles the question it was run to settle rather
than the general one. It shows medium buying nothing on a chapter where low
already succeeds; it does not show that no chapter exists where deliberation
would help. Reopening this means new measurement, not a re-run of the original
argument. ADR-0004's conclusion is untouched either way: Sonnet is still the
default.

## Consequences

Effort spends against the only reason Luna's row exists. Luna earns it by
costing roughly a twelfth of Sonnet's list rate on output — which is where
reasoning tokens bill, at $1.20/MTok, eroding exactly that margin. The registry
originally assumed 12000 output tokens per chapter for the OpenAI rows, six
times the Anthropic figure, on the expectation that reasoning would dwarf the
answer. That figure was recorded here as unmeasured, to be corrected by one live
chapter. It has been, and it was wrong by more than an order of magnitude in the
expensive direction: the probed chapter spent 1290 output tokens at medium and
1054 at low, so the gate quoted $0.015373 against $0.002039 actually spent — 7.5×
over. Extrapolated across the reference book (48 narrative chapters, 92,955
words) that was roughly $0.75 quoted against about $0.10, with the output
estimate alone accounting for over 90% of the gap. The same book now quotes
about $0.14.

The OpenAI rows now carry 1290: the higher of the probe's two runs, not the mean
of them and not the low-effort figure the seam actually pins. A row's estimate is
a ceiling, and taking medium's number keeps headroom over what a low-effort run
spends. A gate that over-quotes makes a run look worse than it is; a gate that
under-quotes stops being a gate. The vendor's reported output count already
includes reasoning tokens, so no separate accounting is needed.

Read the ceiling for what it is: 1290 is the higher of two *efforts* on one
chapter, not a ceiling across chapter lengths. That chapter was 1358 words
against the reference book's ~1937-word average, and output scales with input,
so a long chapter can spend more than 1290 and be under-quoted. The gate is a
whole-run total, and over 48 chapters the short ones subsidise the long ones, so
this bites a single-chapter probe of a long chapter rather than a book run. It is
a known limit of a one-chapter measurement, not an oversight — narrowing it means
measuring more chapters, which is what the next OpenAI run should be spent on.

The per-word input constant is deliberately left alone at 2.7. It tracks the
Anthropic baseline closely (measured 2.65) and over-estimates OpenAI, which is
the safe direction: the probed chapter was 1358 words and 2455 input tokens,
1.81 per word.

Correcting the estimate changed what that decision costs, and the arithmetic is
worth stating because it inverts. Against the old 12000 the input side was ~6%
of an OpenAI quote and could be waved away. Against 1290 it is ~39% of a chapter
quote and ~45% of a reference-book quote — the input side is now nearly half of
what the gate charges an OpenAI run. Carrying 2.7 rather than 1.81 therefore
inflates an OpenAI quote by roughly 10–15% overall. That is still the safe
direction and still small next to the 7.5× it replaces, and one constant shared
by both vendors is worth more than a per-provider pair that has to be
re-measured whenever either vendor retokenises. But "negligible" is no longer
the reason; "modest, and biased the safe way" is.

The per-chapter token ceiling is 16000, unchanged. Reasoning and the answer draw
on it together, so truncation was a live risk at medium; at low, with the probe
reporting zero reasoning tokens and about a fifteenth of the ceiling spent on
output, it is remote. If a chapter does truncate, that is still the cause, and it
says nothing about the model's extraction quality.
