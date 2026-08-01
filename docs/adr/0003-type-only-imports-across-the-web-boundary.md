# The web app imports types from the pipeline, never values

`web/` shares the pipeline's data shapes through a path alias to `src/types.ts`,
but may only use `import type`. Type imports are erased at compile time; a value
import would pull the pipeline's node16-CJS code into the browser bundle graph
and fail in a way that is hard to trace back to its cause.

The visible consequence is that runtime constants the two sides share — the
character-role and event-significance orderings — are deliberately declared
twice. That duplication is load-bearing, not an oversight; deduplicating it by
importing the pipeline's copy is exactly the change this decision exists to
prevent.
