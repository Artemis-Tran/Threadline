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

## Reasoning effort is pinned, at medium

The OpenAI rows are called at medium reasoning effort. The pinning is the
decision, not the value: medium happens to be GPT-5.6's own default, and "it's
the default anyway, drop the parameter" is the simplification to resist.
Reasoning tokens bill as output and spend the same budget the answer needs, so
effort has to be a number the registry's output estimate is sized against, not
whatever a vendor defaults to this quarter.

Medium rather than low is contested and unmeasured, and should be read that
way. The case for low is that extraction is mechanical read-and-structure work
that deliberation cannot improve. The case for medium is that ADR-0004 found
the cheap-model failure mode on this task to be roster noise — walk-ons
promoted to characters, one person fragmented across several entries — which is
a judgment failure rather than a transcription one, and deliberation is a
plausible lever against it. Neither position has been tested; the first Luna
probe settles it. ADR-0004 supports this choice rather than obstructing it, and
its conclusion is untouched: Sonnet is still the default.

## Consequences

Effort spends against the only reason Luna's row exists. Luna earns it by
costing roughly a twelfth of Sonnet's list rate on output — which is where
reasoning tokens bill, at $1.20/MTok, eroding exactly that margin. The registry
therefore assumes 12000 output tokens per chapter for the OpenAI rows, six
times the Anthropic figure, so that the cost gate stays a ceiling. That
estimate is unmeasured; one live chapter corrects it, and the vendor's reported
output count already includes reasoning tokens, so no separate accounting is
needed.

The per-chapter token ceiling is 16000, and at medium effort the reasoning and
the answer draw on it together, so a long chapter is likelier to come back
truncated than it would at low effort. If a probe truncates, that is the cause,
and it says nothing about the model's extraction quality.
