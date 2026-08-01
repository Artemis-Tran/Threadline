# Threadline

Threadline turns a book into a **thread**: a structured description of its
characters, relationships, and events, indexed by chapter so a reader can see
the story as it stood at any point without being spoiled past it.

## Language

### The book

**Parsed book**:
A book reduced to ordered chapters of clean prose, stripped of markup and
front/back matter.

**Chapter**:
The unit of everything. Extraction, spoiler-gating, and the timeline are all
indexed by chapter position, never by page or percentage.

### Extraction

**Chapter extract**:
The structured characters, relationships, and events drawn from a single
chapter. Exactly one per chapter — there is no sub-chapter splitting.
_Avoid_: chunk, checkpoint

**Roster**:
The running list of characters seen so far, carried into the next chapter's
extraction as a hint so the same person isn't renamed mid-book. Deliberately
lossy and never authoritative.

**Extraction model**:
The priced, registry-known identity an extraction run is pinned to. Exactly one
per run, recorded by the manifest and by every chapter extract. The snapshot a
vendor actually serves may differ from the requested identity; the run is named
by what it requested.

**Manifest**:
The record of one extraction run over one book — what was extracted, skipped,
or reused, which extraction model it ran on, and what it cost.

### The thread

**Thread**:
The merged, deduplicated whole-book result: one entry per character,
relationship, and event, each carrying its per-chapter history.
_Avoid_: skin

**Appearance**:
How one chapter described one character. A character's appearances are the
evidence the thread is built from; the character's top-level description is
just the most recent one.

**Relationship statement**:
What one chapter asserted about a pair of characters. The relationship's
`current` value is the latest statement, not a summary of all of them.

**Character role**:
A character's weight in the story — point of view, major, supporting, minor,
or mentioned. Assigned per chapter, so it can change as the book moves.

**Event significance**:
How much an event matters — major, moderate, or minor.

### Progression and contradiction

**Progression order**:
A ranked vocabulary the book uses to mark advancement, such as Tier's
Red → Orange → Yellow → Green. Always supplied by a human; never inferred
from the text.

**Progression regression**:
A later chapter placing a character *earlier* in a progression order than an
earlier chapter did. A signal that one of the two extractions is wrong, not
proof of which.
_Note_: Regressions in the Tier key alone are called **conflicts**, for
backward compatibility with the pre-generalization field name.

### The wiki

**Chapter cap**:
The reader's declared position — "show me the world as of chapter N". The
centerpiece of the wiki: everything shown is recomputed from history filtered
to the cap, never taken from the thread's whole-book fields.
_Avoid_: spoiler slider, progress marker

**Story map**:
The timeline drawn as a chart rather than a list: characters as vertical
lanes, events as points where their lanes converge.

**Lane**:
One character's vertical track through the story map.
