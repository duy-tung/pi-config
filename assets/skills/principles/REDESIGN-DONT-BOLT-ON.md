# P5. Redesign, don't bolt on; converge on the target

**Rule.** Integrate a new requirement as if it had been a foundational assumption from day one. Then converge on that end state instead of preserving smooth intermediate states with compatibility code.

**Apply.**

- Read every affected file first. Ask: "if we were writing this from scratch with this requirement, what would we build?"
- Propagate the change through every reference: types, docs, examples, tests.
- Design the whole redesign, then deliver it in verifiable units (P10).
- In a planned rewrite, end-state integrity beats transitional stability. Intermediate breakage is acceptable when it is planned, scoped and reversible: declare where, keep checks green on the areas you touch, and run full static and runtime verification at the end.

**Legacy APIs: decide by who owns the callers.**

- **You own every caller, and the migration fits one wave:** inventory the callers, migrate them, and delete the old API in the same change. Rewrite tests to the new contract and delete tests that only protect old internals. A temporary adapter is a time-boxed exception, not architecture.
- **Callers are external** (a published package, a public API, installed mobile builds, another team's service), **or the migration spans many sessions:** use expand-contract. Expand: add the new form beside the old. Migrate in batches sized by blast radius, each batch green. Contract: delete the old form once no caller remains. To plan it as tickets, tell the user to run `/skill:to-tickets`.
- Either way, the old path gets a scheduled deletion. A dual path with no end date becomes permanent.

**Test.** If this requirement had been known from the start, would the code look like this?

> Keeping both old and new APIs creates dual-path complexity, slows cleanup, and makes the codebase feel append-only.
