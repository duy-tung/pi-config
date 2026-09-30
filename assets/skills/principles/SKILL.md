---
name: principles
description: "Fourteen named engineering principles as steering vocabulary. Use when choosing between approaches, sizing or ordering a change, or explaining a decision. Read a principle's file before citing it."
---

# Principles

In your reply, name each principle that changed a decision and the specific choice it changed. A principle named with no decision behind it is a name-drop.

Read a principle's file before you cite it. Each file holds the rule, how to apply it, and its test.

| ID | Principle | Rule | Applies when | File |
|---|---|---|---|---|
| P1 | Smallest change, subtract first | Most result, least code. Remove before you add. | Sizing a diff; refactoring; tempted to add a layer, flag or abstraction | [SMALLEST-CHANGE.md](SMALLEST-CHANGE.md) |
| P2 | Minimize reader load | Few layers to trace, little state to hold. Deep modules. | Shaping or reviewing code that is hard to trace | [READER-LOAD.md](READER-LOAD.md) |
| P3 | Data first, model the domain | Name the data shape and its structure before logic. | Any code; stateful logic; branches that repeat a shape assumption | [DATA-FIRST.md](DATA-FIRST.md) |
| P4 | Parse at the system boundary | Validate once where data enters; make illegal states unrepresentable. | Validation, error handling, types, signatures | [PARSE-AT-THE-BOUNDARY.md](PARSE-AT-THE-BOUNDARY.md) |
| P5 | Redesign, don't bolt on | Build as if the requirement was there from day one, then converge on it. | A new requirement in an existing design; migrations; legacy APIs | [REDESIGN-DONT-BOLT-ON.md](REDESIGN-DONT-BOLT-ON.md) |
| P6 | Fix root causes | Fix where the wrong state is produced. After two failed fixes, attack the premise. | Debugging; a check that keeps failing | [ROOT-CAUSES.md](ROOT-CAUSES.md) |
| P7 | Design it twice | Compare structurally different candidates before committing. | A design with no precedent in the codebase | [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md) |
| P8 | The consumer's usage is the spec | Write the consumer's usage first; choose their experience over your convenience. | Product, UX, API shape, scope trade-offs | [USAGE-IS-THE-SPEC.md](USAGE-IS-THE-SPEC.md) |
| P9 | Build the lever, encode the lesson | Build the tool that does or proves the work; encode a recurring correction in the strongest mechanism. | Non-trivial or repeated work; a correction given twice | [BUILD-THE-LEVER.md](BUILD-THE-LEVER.md) |
| P10 | Prove it on the real artifact, unit by unit | Small vertical units, each green on the real artifact before the next. | Multi-step work; declaring done; ordering commits | [PROVE-UNIT-BY-UNIT.md](PROVE-UNIT-BY-UNIT.md) |
| P11 | Test behavior, not implementation | Call the code as its users do; assert a literal expected value. | Writing, changing or keeping a test | [TEST-BEHAVIOR.md](TEST-BEHAVIOR.md) |
| P12 | Converge under retries and concurrency | The same end state however often it runs; no shared write target. | Commands, lifecycle steps, loops, parallel workers | [CONVERGE.md](CONVERGE.md) |
| P13 | Guard the context window | Bulk to subagents, summaries in the main thread. | Large outputs, long files, fan-out | [GUARD-THE-CONTEXT.md](GUARD-THE-CONTEXT.md) |
| P14 | Block on direction, never on execution | The human sets direction up front; reversible execution proceeds; irreversible actions stop. | About to ask the human something | [BLOCK-ON-DIRECTION.md](BLOCK-ON-DIRECTION.md) |

When two principles pull apart, name both and the choice you made. Known tensions:

- **P1 against P5 and P6.** A root-cause fix or a redesign can be larger than a patch. P1 minimizes the diff of the correct fix; it never trades away correctness.
- **P2 against P3.** A structure that deletes branches (P3) can add a layer (P2). Keep it only when it removes more reader load than it adds.
- **P9 against P1.** The lever is the smallest script that does or proves the job, never a framework.
