# Progression orders are human-configured, never inferred

Detecting that a character moved backwards through a book's advancement system
requires knowing that system's order. We take that order from an explicit
human-supplied config and never infer it from the book's text, even though the
text plainly contains the evidence.

Guessing an order wrong would silently invent contradictions in a thread that
is otherwise correct, and a false regression is worse than a missed one — it
sends a human to re-read a chapter for a problem that was never there. Tier's
own order ships as the built-in default, expressed as config rather than as a
special case in the code.
