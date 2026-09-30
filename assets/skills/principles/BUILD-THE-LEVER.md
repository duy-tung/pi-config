# P9. Build the lever, encode the lesson

**Rule.** For non-trivial work, build the tool that does or proves it (a codemod, script, generator or rerunnable check) instead of working by hand. When a correction recurs, encode it in the strongest mechanism instead of more prose.

**Apply: the lever.**

- Do the first unit by hand to learn the recipe, then build the tool. Prove it by rerunning it on that unit and diffing against your hand version. Make it safe to rerun.
- A codemod or script for edits, a generator for repetitive files, a dump-to-sqlite query for analysis, a rerunnable check for verification.
- A deterministic lever beats fan-out. If one pass of a script covers every unit, run it yourself.
- When you fan work out, write the recipe, the verification contract and the do-not-touch fences in one file the workers read and cannot edit.
- The bar is triviality, not repetition. A one-off earns a lever when the lever is what makes the work checkable. Build the smallest script that does the job, never a framework.
- Commit the lever when the work outlives the session.

**Apply: the lesson.** The second time you write the same instruction, move it to the strongest mechanism that fits:

1. Make it impossible: types, architecture.
2. Static analysis: a lint rule, a banned API, the type checker, a hook, CI.
3. A review-time standard in `CODING_STANDARDS.md`.
4. A skill or a pointer doc.
5. Prose in AGENTS.md.

Agents copy whatever the surrounding code already does, so a weak guard becomes the next template. When the fix is structural, ship only the structural fix and delete the instruction. To route lessons after a long task, tell the user to run `/skill:reflect`.

**Test.** If you cited this principle and the diff has no codemod, script, generator, check or worker brief, you did not apply it.

> A deterministic script turns "trust me" into "run this".
