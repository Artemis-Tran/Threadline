# What counts as a character is decided at extraction, not downstream

The extraction prompt states a definition of **character** and applies it. Two
classes fall outside that definition and are handled differently, on purpose:
incidentals are **suppressed** and never reach disk, collectives are **kept and
tagged**. Nothing downstream re-derives the boundary — the merge step only
reconciles the tag, and the wiki only filters on it.

This is written down because the prompt was silent about it for the project's
whole life, and the silence was the defect. `CONTEXT.md` defined *character
role* — pov, major, supporting, minor, mentioned — but never the thing being
assigned a role, and the prompt inherited that gap: "extract the characters that
appear in this chapter" left the boundary entirely to the model. Two models, and
one model on two books, then disagreed by 49 and 76 entries.

## The rule

As it stands in `buildSystemPrompt` (`src/extract-book.ts`), in three clauses:

**Qualifies.** An entity the story treats as an actor — something that acts,
chooses, or speaks of its own accord — and refers to by a stable designator.
Personhood is not required: a god, a beast, a ship, or a system counts if the
story gives it agency.

**Suppressed.** An entity whose designator identifies it only by what it did or
where it stood in this scene. `Woman at the second fountain`, `Toddler`, `First
customer`, `the elderly basket weaver`. A stable designator is one the entity
carries *outside* the scene — a name, or a standing post the story treats as
ongoing.

**Tagged.** An entry standing for more than one entity — a body, crew,
household, order, crowd, business, or institution acting together — gets
`kind: "collective"`. Everything else gets `kind: "individual"`.

Two boundaries inside that are worth stating because they were each bought with
a paid run:

- **`Elise's governess` stays, `the driver` goes.** Both are bare role nouns; the
  property that separates them is whether the post is ongoing. The prompt asks
  for it as a mechanical test — *could a later chapter refer to this entity by
  this designator?* — rather than as more explanatory prose. That sharpening was
  forced by the audit; the first run's softer wording left roughly twice as many
  survivors. See "Where the rule still leaks" for what the test cannot do.
- **Agency, not just non-personhood.** "Personhood is not required" alone
  generalised from *a god, a ship, a beast, a system* to a potter's stock:
  `Tea ceremony set`, `Evening lamp`, `Ceremony Stone`, `Eternal Fountain`.
  Requiring that the thing act of its own accord cleared all six, while
  `The System` — 29 chapters, 9 relationships — survived untouched. A thing only
  made, sold, carried, displayed, or used is not a character however important or
  magical it is.

A named one-scene character is unaffected. `Mira`, `Aldric`, `Gregor` pass the
test and are legitimate `minor` characters. This rule does not suppress the
`minor` or `mentioned` roles, and nothing about *character role* changed.

## Incidentals are suppressed, and that is the expensive half

They are not tagged and filtered like collectives — they are never emitted. The
reasoning is that there is no plausible wiki surface for `Toddler`, so there is
nothing worth the schema field and the disk.

**The cost is that the incidental boundary is permanently more expensive to
revisit than the collective one.** Anything suppressed is absent from paid output
for good; moving that line even slightly means re-extracting every affected book
at full price. The collective boundary can be moved by editing a filter over data
already on disk. This asymmetry was accepted knowingly, and it is the single
thing most likely to be regretted — if a future surface wants walk-ons, no
existing thread can supply them.

## Collectives are kept because suppressing them destroys relationships

This is not a preference about list contents. **The merge step drops any
relationship with an unresolved endpoint entirely** — unlike an event
participant, which survives as an unlinked name. Suppressing collectives at
extraction would therefore have deleted every relationship they take part in,
irrecoverably short of re-extraction. `The System` alone carried nine.

So extraction keeps emitting them, `kind` marks them, and the wiki filters them
out of the characters list while leaving them resolvable by id — detail pages,
event participants, and graph nodes all keep working. The tag costs one optional
schema field today and makes a future **group** surface purely additive display
work, with no re-extraction of anything already paid for.

Two rules follow from the tag being per-chapter:

- A merged character's `kind` is the **majority of its appearances**, ties
  resolving to `individual`. The two errors are not symmetric: a leaked
  collective is visible and mildly annoying, while a real person hidden by one
  stray tag is invisible and unrecoverable by inspection. Consistent with
  ADR-0007 — this is the merge step reconciling per-chapter disagreement, which
  is what it is for, not repairing an extraction gap.
- **No name-based heuristic infers `kind` anywhere.** Classification is the
  model's job through the prompt; guessing "sounds plural" downstream was
  rejected, which is also why there is no backfill script for existing threads.

`kind` is optional throughout, and **absent always means `individual`**, so
threads extracted before this rule keep loading unchanged.

## The count is an output, not a target

No acceptance criterion anywhere is a character count. Matching another model's
number was considered explicitly and rejected: Sonnet produced 67 characters on
The Potter's Path and 143 on Pale Lights, so the baseline swings by more than 2×
between books and is demonstrably wrong in at least one direction. Tuning toward
it would be tuning toward a contaminated number.

The measured effect is worth recording precisely because it looks like a failure
if read as a count. Two whole-book runs of The Potter's Path on the pinned
configuration (`gpt-5.6-luna`, effort `high`), $0.36 and $0.37:

| run | prompt | total | individual | collective |
| --- | --- | --- | --- | --- |
| baseline | no rule | 116 | 116 (untagged) | 0 |
| run 1 | definition + suppression prose | 128 | 86 | 42 |
| run 2 | mechanical test | 136 | 89 | 47 |

The **total went up**. The number a reader actually sees is the individual
column, because the wiki filters collectives out: 116 → 89, down 23%. The total
rose because the model now folds a crowd into one tagged collective instead of
emitting six walk-ons — the design working, not failing. Anyone reading the
totals alone will conclude the opposite.

## The premise this started from did not survive the data

The investigation opened as "Luna over-recognises against Sonnet — tune it
down". That is wrong, and it should not be reintroduced.

Sonnet's 143 on Pale Lights contains `unnamed woman`, `toothless old man`,
`guardswoman`, `innkeeper`, `watchwoman at gate`, `gravebird`. Its 67 on The
Potter's Path contains `elderly basket weaver`, `dock worker`, `young mother
customer`, `guild hall clerk`. And Sonnet *missed* `Aldric`, a named supporting
character that Luna caught. Both vendors express the same defect and differ in
degree, not in kind. It was never a model problem, which is why the fix is
prompt-level and therefore vendor-neutral — it reaches both providers through the
call seam (ADR-0008) and the single-chapter probe for free, and there is no flag
to turn it off. The rule is the definition of a domain term, not a per-run
option.

## Where the rule still leaks

**The audit did not reach zero disallowed entries, and this ADR records a rule
that is known to be incompletely enforced.** Run 2 left roughly twelve survivors,
all one shape — a one-off functionary designated by their job: `the runner`, `the
messenger`, `the driver`, `military courier`, `the gallery attendant`, `elderly
noble`.

The root cause is structural, not a wording problem. The property separating
`Elise's governess` from `the driver` is **recurrence**, and a per-chapter
extraction cannot observe recurrence — the mechanical test asks the model to
predict chapters it was never given. Sharpening the wording halved the class and
then stalled, which is the evidence that more prose will not close it.

Two things follow, and neither belongs in the prompt:

- The remaining class needs either a decision to accept one-off functionaries, or
  suppression by recurrence at **merge**, which can see all 47 chapters and count
  appearances. That is a different change and a free one — it re-uses extracts
  already on disk.
- One contradiction found by review after run 2 is fixed but **not yet validated
  by a paid run**: the prompt offered "the guild clerk" as a *passing* example of
  a standing post while that exact class was what survived. A third run should be
  cheaper to interpret with it gone.

Related and unaddressed here: collective drift (bare plural nouns like
`customers`, `shopkeepers` tagged as collectives — harmless while collectives are
filtered, and a problem when the group surface lands), and the fact that nothing
stamps a prompt identity onto a chapter extract, so re-running a book after a
prompt change silently mixes old-rule and new-rule extracts that ADR-0007
guarantees merge will not reconcile.
