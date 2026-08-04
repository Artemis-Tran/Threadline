# Sonnet is the default extraction model

> **Superseded by [ADR-0009](0009-luna-is-the-default-extraction-model.md).**
> The default is now Luna, on a 12–15× price advantage and not on a quality
> finding. What this ADR established about the *failure mode* of a cheap model
> on this task — roster noise, walk-ons promoted, one person fragmented across
> entries — is not superseded and is still the thing to watch for. Only the
> conclusion about which model a no-flag run uses is.

Extraction runs on a configurable model, and we default to Sonnet. A
head-to-head run of the same book showed Haiku costs roughly a seventh as much
but produces a noisier thread — it promotes unnamed background walk-ons to
characters and fragments names, splitting one person into several entries.

That noise lands squarely on the merge stage, which is the hardest part of the
pipeline to get right, so the saving is not as real as it looks.

## Considered options

- **Haiku** — $0.54 per book against Sonnet's $3.95, but the roster needs
  cleanup that partly defeats the point. Reopening this is reasonable if
  extraction volume grows; the untried lever is a prompt change suppressing
  unnamed background figures, not a straight model swap.
- **Opus** — reserved for a specific reasoning failure Sonnet demonstrably
  can't handle. Not a default.
