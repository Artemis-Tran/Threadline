# The merge stage does not repair extraction gaps

The merge stage reconciles disagreements *between* chapter extracts. It cannot
recover a fact that extraction never captured, and it should not be extended to
try.

The motivating case: one chapter reveals a character's tier indirectly, through
another character's dialogue. Extraction missed it, so all four of that
character's chapter extracts carry the same wrong value — they agree with each
other. There is no contradiction in the JSON to detect, and no merge rule
operating on JSON alone can find one.

Closing this gap would require re-reading the original chapter prose with an
LLM, which costs real money per book and belongs to extraction, not merging.

## Consequences

Treat "the merge missed a fact" as an extraction bug by default. A regression
detector that reads only structured output has a ceiling, and this is it —
tightening the merge's heuristics against cases like this will produce false
positives rather than catching the miss.
