# P6. Fix root causes; attack the premise after two failures

**Rule.** Trace every symptom to its root cause and fix it there. When two fixes that share one premise fail the same check, suspect the premise, not the fixes.

**Apply.**

- Reproduce first. Ask "why" until you reach the code that produced the wrong state.
- No symptom guards: a null check that silences a crash, a retry that hides a broken contract, a cast that hides a modeling error.
- If a workaround needs a paragraph-long comment to justify it, the code is wrong. Fix the code, not the comment.
- Fix the pattern, not the instance: grep for every occurrence.
- When stuck, instrument. Do not guess.
- A bug that shows up after a restart points at stale persistent state first: config, caches, lock files, serialized state.
- After two failed fixes, write the premise down, take a per-actor census as a rerunnable script, read the skew, and remove the asymmetry instead of compensating for it. If the census is even across actors, the premise is not the cause.

The full procedure is the `diagnose` skill.

**Test.** Does the fix change the code that produced the wrong state, or only the code that noticed it?

> Each failure under a shared premise is evidence about the premise.
