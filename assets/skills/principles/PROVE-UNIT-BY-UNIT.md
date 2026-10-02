# P10. Prove it on the real artifact, unit by unit

**Rule.** Break work into small vertical units that each end in a state you check on the real artifact. Do not start the next unit until the current one is green.

**Apply.**

- **Vertical slices.** Each unit cuts a narrow but complete path through every layer it needs (schema, API, UI, tests) and is demoable or verifiable on its own. Never a horizontal layer.
- **Scaffold first.** Whatever helps every later phase comes first: CI, lint, test infrastructure, shared types, and the verification harness with a pre-change baseline, so each check reads old value against new value.
- **Before-and-after brackets.** A known-good state, one change, run the check, then proceed. Rebase onto a clean trunk first so every check measures against the real baseline.
- **Check the real thing, not a proxy.** Read the actual value; observe the running app. File mtimes, cached state, self-reports and "it compiles" are proxies.
- **Verdicts are VERIFIED, NOT VERIFIED or INCONCLUSIVE.** Inconclusive is not a pass. Do not hide a negative.
- **Delivery order proves the work:** the failing test, then the fix; subtraction before reshape; baseline before treatment; scaffold before feature. Each commit lands on its own, and the sequence reads as an argument.
- Script the check and keep its output.

**Test.** At any moment, can you name the last green check and what it observed?

> A break caught at the unit that caused it is cheap to localize.
