# Every pipeline stage writes inspectable JSON before the next one runs

No stage pipes its output directly into the next. Each writes a file first, and
the next stage reads that file.

This exists because the expensive stage is in the middle: a bad parse that goes
straight into extraction burns real API budget before anyone notices. A file
between every pair of stages means a human can look at the output and stop,
and it makes a re-run resumable rather than a fresh charge.
