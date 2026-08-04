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

## Reasoning effort is pinned, at high

The OpenAI rows are called at high reasoning effort. The pinning is the decision,
not the value: reasoning tokens bill as output and spend the same budget the
answer needs, so effort has to be a level the registry's output estimate is
sized against, not whatever a vendor defaults to this quarter. That was worth
saying when the pinned value was also GPT-5.6's default and "drop the parameter,
it's the default anyway" was the available simplification. It is now
load-bearing in the ordinary way, because high is not the default.

The pin reached high by way of medium and then low, and the route is kept below
rather than tidied away — the wrong turn is the most useful thing this section
records, because it was a measurement flaw and not a reasoning one.

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
argument for it did not survive its own test, and low was pinned. Both efforts
also passed the probe's gating checks: closed vocabularies honoured, and a
roster entry (`"Henry Ashford"`) reused verbatim against a chapter that says
"Henry" 22 times and never "Ashford".

The pinned effort is stamped onto every chapter extract and onto the manifest,
under `reasoningEffort`, taken from the seam's pin rather than restated by the
caller. Because the pin is a constant and not a flag, the request body was
otherwise the only place the effort existed, and nothing on disk said which
effort produced an extract — two runs of the same book at different efforts were
indistinguishable except by what someone had named the directory. That was
tolerable while the only multi-effort runs were two one-chapter probes; it stops
being tolerable as soon as a whole book exists at more than one effort. The field
is absent, not null, on Anthropic extracts: that vendor has no such concept, and
a no-flag Anthropic run's output stays byte-identical to what is already on disk.

This is one chapter, and it settles the question it was run to settle rather
than the general one. It shows medium buying nothing on a chapter where low
already succeeds; it does not show that no chapter exists where deliberation
would help. Reopening this means new measurement, not a re-run of the original
argument. ADR-0004's conclusion is untouched either way: Sonnet is still the
default.

### The measurement came, and the probe had been asking the wrong chapter

Three whole-book Luna runs, at low, high and max, against The Potter's Path:

| run | cost | wall time | characters | Merrick ≠ Pelham | Lydia ≠ Martha | Greaves intact |
|---|---|---|---|---|---|---|
| Sonnet (baseline) | $3.95 | — | 67 | ✓ | ✓ | ✓ |
| Luna low | $0.12 | 8m | 115 | ✗ | ✗ | ✓ |
| Luna high | $0.25 | 22m | 116 | ✓ | ✓ | ✗ |
| Luna max | $1.04 | 104m | 138 | ✓ | ✓ | ✗ |

**Deliberation does buy something, and the one-chapter probe could not have seen
it.** At low, Luna emits `"Davos Merrick"` carrying `"Pelham"`, `"Lord Pelham"`
and `"Lord Garrett Pelham"` as aliases — two distinct characters collapsed into
one — and `"Lydia"` carrying `"Martha"`, a one-scene customer folded into the
baker. Both are extraction-time errors, not merge-time ones, and both are then
propagated by the roster: once written, the bad alias enters the roster, the
roster enters every later prompt, and the Lydia/Martha merge rides forward
through five chapters. High and max both eliminate both.

The reason the earlier probe concluded otherwise is a flaw in the probe, not in
the reasoning. It ran chapter 1 at each effort. Chapter 1 has an empty roster and
nine unambiguous characters, so there is no identity judgment to make and nothing
for deliberation to do — an identical character set at both efforts was the only
possible outcome. Identity errors happen deep into a book against a large roster,
where the model must decide whether a name it is seeing is someone it has already
met. A probe against an empty roster structurally cannot test the failure the
roster exists to prevent. The original argument for medium — a judgment failure
rather than a transcription one, against which deliberation is a plausible lever
— was directionally right and was retired on evidence that could not bear on it.

**Effort saturates above high.** Max is identical to high on every defect
measured: the same two fixes, and the same failure, splitting `"Greaves"` into
`"Blacksmith next door"` (21 chapters) and `"Greaves"` (4 chapters) with the same
division. For four times the money and five times the wall time it changes no
correctness outcome, and it makes roster noise worse — 138 characters against
high's 116, 64% of them appearing in a single chapter.

**No Luna effort is clean, and the failures are opposites.** Low collapses
distinct people into one entry; high and max split one person across two. ADR-0004
names both as the cheap-model failure on this task, and Luna picks one or the
other depending on effort rather than escaping the pair. High's fragmentation is
arguably the worse of the two: Greaves is a 24-chapter principal, where
Pelham and Martha are minor. Sonnet exhibits neither at any point. ADR-0004's
default is not merely untouched by this; it is reinforced.

### Max effort is operationally unusable at the current token ceiling

`MAX_TOKENS` is 16000, and reasoning draws on it alongside the answer. At max
effort on an entity-dense chapter that budget is not close to enough. Chapter
index 5 — 16 characters — exhausted a deliberately raised 24000-token ceiling and
returned **no text at all**: the whole budget went to reasoning and the answer was
never begun, so the run aborted having paid for nothing. At 64000 the same chapter
completed, spending 28,782 output tokens of which 26,945 were reasoning, to
produce a 1,837-token answer. A 15:1 reasoning-to-answer ratio.

Thirteen of the book's 47 chapters carry 12 or more characters, so this is not an
edge case; it is a quarter of the book. Anyone reaching for max has to raise the
ceiling first, and each failed attempt costs the full ceiling in output tokens
because the failure mode is silence rather than a short answer. The truncation
path behaves correctly throughout — text preserved, partial manifest written,
complete manifest untouched, run aborted rather than writing a half-answer — which
is the only reason a budget this wrong is survivable.

### The pin moved to high, and the registry row moved with it

High is pinned. Character collapse is the worst extraction failure available on
this pipeline — merging does not repair extraction gaps (ADR-0007), so nothing
downstream can split what extraction fused, and the roster propagates the bad
alias into every later chapter's prompt. About $0.13 more per book buys the two
collapses away. That is a cost change to every future Luna run, made knowingly.

That is the answer to the objection recorded above, that high's fragmentation is
arguably the worse defect because Greaves is a 24-chapter principal where Pelham
and Martha are minor. Severity by cast size says one thing; recoverability says
the other, and recoverability decides it. A fuse commingles two people's facts
in one record and deletes the fact that they were ever two — nothing in the
output says a split is owed, and only re-extraction can undo it. A split leaves
two records that are each correct about themselves; the merge step will not join
them on its own, since they share no name token, but the defect is visible in the
output and reconcilable there. The failures are opposites, and they are not
equally bad.

**Max is rejected, and should not be re-run.** It matches high on every defect
measured — the same two fixes, the same Greaves split, the same division — for
four times the money and five times the wall time, while making roster noise
worse. It is also operationally unusable at the current 16000-token ceiling, for
the reasons above. The scale saturates at high; there is nothing further up it
to buy.

The registry row moved in the same commit, because it had to. What a run spends
on output is a property of the model *and* the effort together:

| effort | total output, 47 calls | per call | vs the old 1290 row |
|---|---|---|---|
| low | 62,107 | 1,321 | 1.02× over — already not a ceiling |
| high | 167,647 | 3,567 | 2.8× under-quoted |
| max | 823,173 | 17,514 | 13.6× under-quoted |

Max's per-call figure is above `MAX_TOKENS`, which is 16000, so that run cannot
have been made at the shipped ceiling — another way of saying what the section
above says outright.

The OpenAI rows now carry 4500, which sits about a quarter above high's measured
3,567 per call. Say what that is rather than flattering it: 3,567 is a whole-book
mean, so 4500 is a ceiling over the average call and not over every call. The row
is sized to hold across a run, which is the unit the gate quotes; a single
entity-dense chapter can still beat it. Raising the pin without raising the row
would have
left the cost gate — the pipeline's only guard against unintended spend, and the
only thing stopping the single-chapter probe from paying twice — quoting 2.8×
under the truth on every OpenAI run. That is worse than the status quo it
replaces, so the two are one decision and not two.

Note that 1290 was already below low's own 1,321 per-call average. The row had
stopped being a ceiling at the effort it was taken at, so correcting it was
warranted independently of the pin; the pin is what made it urgent.

**The methodology lesson, which generalises past this decision.** A one-chapter
probe on a chapter with an empty roster cannot test an identity-judgment
question. It has nothing to be confused about: every name is new, so "is this
someone I have already met?" is never asked, and any two configurations will
agree. Identity errors live deep into a book against a large roster. A future
model or effort comparison on identity, alias reuse, or roster carry-forward
needs a mid-book chapter with a seeded roster — the single-chapter probe takes
both a chapter index and `--roster`, so that is one paid call away.

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
estimate alone accounting for over 90% of the gap. At 1290 the same book quoted
about $0.14; at 4500 against the pinned high effort it quotes about $0.32,
against the $0.25 a whole-book high run actually cost. That is a gate doing its
job — over by a quarter, in the direction that is safe to be wrong in.

The OpenAI rows now carry 4500, sized against the pinned high effort and clearing
its measured 3,567 per call. The figure it replaces, 1290, was the higher of a
one-chapter probe's two runs, taken while the seam pinned low; how that number
was arrived at and why it stopped holding is above. A gate that over-quotes makes
a run look worse than it is; a gate that under-quotes stops being a gate. The
vendor's reported output count already includes reasoning tokens, so no separate
accounting is needed.

Read that older ceiling for what it was: 1290 was the higher of two *efforts* on
one chapter, not a ceiling across chapters. It was recorded here as a known limit
of a one-chapter measurement, to be narrowed by spending the next OpenAI run on
more chapters. That run was spent — three consecutive chapters, indices 4–6 of the
reference book, on Luna at the then-pinned low effort — and it did not narrow the
limit so much as refute the shape of it:

| idx | words | characters | est. output | actual output |
|---|---|---|---|---|
| 4 | 1560 | 9 | 1290 | 1353 |
| 5 | 1576 | 19 | 1290 | 1777 |
| 6 | 1969 | 14 | 1290 | 1499 |

All three overran, and the run spent 4629 output tokens against 3870 quoted — 120%
of the output side.

A whole-book run at the same effort has since put that in proportion, and the
three-chapter figure was the more misleading of the two. Across 47 chapters low
spent 62,107 output tokens, averaging 1,321 against the row's 1290 — over by 2%,
not 20%. Chapters 4–6 are the book's opening, where the roster is being built from
nothing and every character is new, so they are unusually character-dense and
overstate the overrun. The row was wrong in the unsafe direction even against
that gentler figure, and a single chapter could still exceed it badly — but not
by anything like the margin the first sample suggested. 4500 clears low outright
and high with headroom. What survives is a caution about three-chapter windows as
much as about any row: a short window at the front of a book samples the densest
chapters it has.

The predicted cause was wrong too, and that is the more useful correction. The
expectation above was that output scales with input, so a *long* chapter would
overrun. The shortest chapter here overran, and the worst overrun was the
middle-length one. What separates them is how many characters the chapter yields:
19 for the worst, 9 for the mildest, at 94–150 output tokens per extracted
character throughout. Output tracks the size of the answer, and the answer is a
roster, not a retelling. A chapter that introduces a crowd is the expensive one —
which is why the probed chapter under-read it, having found six names.

The whole-run quote still held, at $0.007351 spent against $0.008121 quoted. It
held by compensating error rather than by design: the 2.7-tokens-per-word input
constant quoted 17384 input tokens against 8979 actually spent, and that slack
paid for the output overrun. Two errors of opposite sign in one gate is a worse
position than one honest over-estimate, because tightening either side alone
un-covers the other. Correcting the row was deliberately left to its own ticket
rather than folded into the port that measured it; that ticket is the one that
raised the pin, because the two are the same decision. With the row at 4500 the
compensating error is gone — the gate over-quotes on both sides now — so the
input constant can be tightened on its own merits without un-covering anything.

The per-word input constant is deliberately left alone at 2.7. It tracks the
Anthropic baseline closely (measured 2.65) and over-estimates OpenAI, which is
the safe direction: the probed chapter was 1358 words and 2455 input tokens,
1.81 per word.

One thing the row's name hides: `outputTokenEstimate` is not a property of the
model. It is a property of the model *and* the pinned effort together — the same
book on the same row spent 62,107 output tokens at low, 167,647 at high and
823,173 at max. Nothing in the registry's *structure* records that dependency, so
moving the pin silently invalidates the gate. Prose is the whole of the
protection there is: the row's comment and the seam's pin each point at the
other, and whoever changes one must change the other in the same breath.

The three-chapter run measured 1.52, 1.88 and 1.85 per word, and the rise across
them is not noise — the roster is carried into every later chapter's prompt, so
input per word climbs as the roster grows. The constant is flat, so it
over-quotes the opening chapters most and least by the end of a book. That is
still the safe direction, and it is invisible to a one-chapter probe, which
always runs against an empty roster and therefore always measures the cheapest
chapter a run will have.

Correcting the estimate changed what that decision costs, and the arithmetic is
worth stating because it has now swung twice. Against the original 12000 the
input side was ~6% of an OpenAI quote and could be waved away. Against 1290 it
rose to ~39% of a chapter quote and ~45% of a reference-book quote — nearly half
of what the gate charged. Against 4500 it falls back to ~15% and ~20%. Carrying
2.7 rather than the measured 1.81 therefore inflates an OpenAI quote by roughly
5% overall, where at 1290 it was 10–15%. That is still the safe direction, and
one constant shared by both vendors is still worth more than a per-provider pair
that has to be re-measured whenever either vendor retokenises. The reason to
leave it alone is not that it is negligible but that it is modest and biased the
safe way — and now the smaller of the two corrections that were available, not
the larger.

The per-chapter token ceiling is 16000, unchanged. Reasoning and the answer draw
on it together, so how much headroom that leaves is a function of the pin. At low
the probe reported zero reasoning tokens and about a fifteenth of the ceiling
spent on output. At the pinned high effort the reference book averaged 3,567
output tokens per call — a little over a fifth of the ceiling — and all 47
chapters completed, so truncation is not a live risk here, but the margin is
thinner than it was and an entity-dense chapter is where it would show first. At
max it is not a risk but a certainty across a quarter of the book, as above. If a
chapter does truncate, that is the cause, and it says nothing about the model's
extraction quality.
