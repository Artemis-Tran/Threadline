# The wiki is a static client-only app, with no server

The reader-facing wiki was first planned as Next.js with SQLite. We abandoned
that before building it and shipped a static Vite + React app instead, storing
the library and per-book UI state in the browser via IndexedDB and hosting it
on GitHub Pages.

A thread is a self-contained JSON file and a reader only ever looks at their
own — there was no requirement a server was actually needed for. Dropping it
removed hosting cost, deployment complexity, and any question of who owns
reader data.

## Consequences

This decision is what makes authentication, multi-user features, and any
backend out of scope rather than merely unbuilt — they have nowhere to live.
Portability is the reader's responsibility, served by JSON export/import,
because clearing browser storage destroys the library.
