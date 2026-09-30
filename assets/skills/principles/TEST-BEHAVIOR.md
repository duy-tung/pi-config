# P11. Test behavior, not implementation

**Rule.** A test calls the code the way its users do and asserts the result they observe against a literal expected value.

**Apply.**

- Test through public interfaces at agreed seams. A test that breaks on a refactor that kept behavior is coupled to the implementation.
- Expected values come from an independent source of truth: a known-good literal, a worked example, the spec. Never recompute them the way the code does.
- Five shapes cannot fail for a defect: weak assertion, mock or absence only, self-referential, constant pin, fixture asserts fixture. Their definitions and fixes are in the `tdd` skill.
- Prefer no new test over a bad test.

**Test.** Would the test still pass if every function it imports returned `undefined`? If yes, rewrite the assertion or delete the test.

> A test that cannot fail for a defect costs CI time and review attention and catches nothing.
