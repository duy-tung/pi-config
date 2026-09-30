# Bug

**You own the root cause. Reproduce on the real surface, fix with evidence, prove.**

1. **Diagnose.** Load the `diagnose` skill. It picks light mode for an obvious one-liner and the full loop otherwise. Reproduce on the same surface the user saw the bug; use the repo's `verify-<app>` skill when present. Ask the user to reproduce only with a stated, specific reason you cannot reach the surface.
2. **Commit the red first.** Commit the failing repro (a test with the runner's expected-failure marker, or a repro script) before the fix, so the history proves the fix.
3. **Fix at the root.** Every shipped line traces to runtime evidence. A guard that "might help" is a hypothesis, not a fix. When evidence refutes a hypothesis, revert what it motivated.
4. **Prove.** Load the `prove` skill. A bug fix meets the repro standard: the broken state twice before, the correct state twice after, on the same path.
5. **Review.** Load the `interrogate` skill and run it with `<commit before the repro> fix`.
6. **No seam, no lock.** If no correct seam existed to test the fix at, say so: that is a design finding. Suggest `/skill:improve-architecture`.

**Reply:** the symptom, the root cause with its evidence, the failing-then-passing output verbatim, the verdict, the commits.
