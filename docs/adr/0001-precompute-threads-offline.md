# Threads are precomputed offline, not extracted on upload

Extracting a thread costs real API money and minutes of wall time per book, so
doing it live when a reader uploads their EPUB would be both slow and
unboundedly expensive. Instead we extract threads ahead of time, one book at a
time under human supervision, and match an uploaded book to an existing thread.

The cost of this is coverage: a book with no precomputed thread gets nothing,
and there is no self-service path to add one. We accept that — a prototype that
is cheap and predictable per reader is more useful than one that is complete.
