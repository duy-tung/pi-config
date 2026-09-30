---
name: tdd
description: "Test-first red-green loop at agreed seams, plus when to skip and which tests are worth keeping. Use when building or fixing test-first, or when asked for TDD, a failing test or a regression test."
---

# TDD

TDD is the red to green loop: a failing test that encodes intended behavior, then the least code that passes it. This skill decides whether to run the loop, where tests go, which tests are worth keeping, and the rules of the loop. Apply every section on every cycle.

Read `CONTEXT.md` if it exists, so test names and interface words match the domain language. Respect ADRs in the area you touch.

## Run the loop or skip it

**Run it** when the user asks for TDD, a failing test or a regression test, when a spec or ticket names seams to test, or when the behavior has an obvious cheap local test target.

**Skip it** when the test path is unclear, expensive, integration-heavy, or not requested. Prove the change on the real artifact instead (load the `prove` skill) and say in the reply why you skipped.

- **Pick the narrowest existing check** that reaches the behavior through a public interface: the unit, component or integration test file already used for that code path. Do not create one from scratch just to satisfy the workflow.
- **Prefer no new test over a bad test.** A bad test mostly tests mocks, encodes the current implementation, depends on timing or global state, needs expensive infrastructure for a small fix, or would be deleted right after proving the fix.

## Seams: where tests go

A **seam** is where a module's interface lives: the place you observe behavior without reaching inside. The interface is the test surface. Tests live at seams, never against internals. Module, interface, seam, adapter and depth mean what the `codebase-design` skill says they mean; when the shape of the interface itself is in question, load the `codebase-design` skill.

**Test only at agreed seams.** A seam is agreed when the spec or ticket names it, the user confirmed it, or an existing test file already tests that public interface. Prefer those. Before the first test at any other seam, write the seam down and ask: "What is the public interface, and which seams should we test?" No test is written at an unconfirmed seam.

In an unattended run, only the ticket's seams and existing ones count as agreed. If they cannot observe the behavior, do not invent a seam: record the gap in the run's decision log and prove the behavior with the `prove` skill instead.

## Tests worth keeping

Tests verify behavior through public interfaces, not implementation details. A good test reads like a specification ("user can checkout with valid cart") and survives refactors. Examples: [TESTS.md](TESTS.md). Mocking: [MOCKING.md](MOCKING.md).

**The undefined-import test.** Before you keep a test, ask whether it would still pass if every function it imports returned `undefined` (or any wrong value). If yes, it observes no behavior and cannot fail for a defect: rewrite the assertion or delete the test. Five shapes fail it:

1. **Weak or no assertion.** No assertion, or only `toBeDefined`, `toBeTruthy`, `not.toThrow`, `toBeInstanceOf`, `toBeGreaterThan(0)`.
2. **Mock or absence only.** Only `toHaveBeenCalled`, `not.toHaveBeenCalled`, `toBeUndefined`, `toEqual([])`, `toHaveLength(0)`, `not.toBe(wrongValue)`.
3. **Self-referential.** The expected value comes from the code under test: `expect(f(a)).toBe(f(a))`.
4. **Constant pin.** The assertion restates a hand-maintained constant, config default, table row or prompt string: `expect(LIMITS.maxTools).toBe(8)`.
5. **Fixture asserts fixture.** The assertion reads data the test built, and the subject never runs in the test body.

The fix: call the subject in the test body with one concrete input and assert the literal output or the observable effect. For an absence, assert the presence on the other input in the same test. For a constant, test the mechanism that reads it. For a mock, assert the payload it received or the state after the call. When no such assertion exists, delete the test. Keep tests of a relation across a table's rows, and compile-time type tests (`*.test-d.ts`).

**Banned even when they pass the undefined-import test:**

- **Implementation-coupled.** Mocks internal collaborators, tests private methods, asserts call counts or order, or verifies through a side channel (querying the database instead of the interface). The tell: it breaks on a refactor that kept behavior.
- **Tautological.** The expected value is recomputed the way the code computes it (`expect(add(a, b)).toBe(a + b)`), so it can never disagree with the code. Expected values come from an independent source of truth: a known-good literal, a worked example, the spec.

## The loop

1. **Name the behavior.** Intended versus current behavior, and for a bug the smallest observable repro.
2. **Red.** Write the smallest test that encodes the intended behavior at an agreed seam.
3. **Confirm it fails for the intended reason:** the behavior assertion, not an import error, a typo or a missing fixture. If it passes, or fails for another reason, fix the test before touching production code.
4. **Green.** Write only enough code to pass it. No anticipated tests, no speculative features. `lens_diagnostics` gives a fast type or lint signal between red and green, but it is not proof: only the test run is.
5. **Rerun** it and its neighbors (the test file or module), then start the next slice.

Rules:

- **Red before green.** Watch it fail before you write the code.
- **One vertical slice at a time.** One seam, one test, one minimal implementation per cycle. Each test is a tracer bullet that responds to what the last cycle taught you. Horizontal slicing (all tests first, then all code) is banned: bulk tests verify imagined behavior and go insensitive to real changes.
- **Refactoring is not part of the loop.** It happens at review (the `interrogate` skill).
- **Never change a test to match a wrong implementation.** Never weaken an assertion unless the expected behavior changed, and then say why.
- **Flaky behavior:** make the test deterministic (pin time, seed randomness, isolate the filesystem) and name the signal it locks down.
- **A bug that exposes a class of failures:** land the focused regression test first, then consider sibling coverage.
- **Bug fixes commit red first.** When the work gets committed, the failing test lands in its own commit before the fix. If hooks or CI reject a red commit, mark the test with the runner's expected-failure marker (`test.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`) and remove the marker in the fix commit. Never bypass hooks.

## Reply

Name the failing-before evidence (the test or check and the failure it produced) and the passing-after run, plus any nearby validation. If failing-before evidence could not be shown, say why and name the closest check used instead.
