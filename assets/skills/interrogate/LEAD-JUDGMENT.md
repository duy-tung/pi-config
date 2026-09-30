# Lead judgment

Reviewers are aggressive by design, and aggression without context produces noise. They saw a slice of the codebase and one paragraph of intent. They do not know what was tried and rejected, the constraints outside the code, which code is temporary scaffolding, or what the next change will address. You have the full context. Filter, contextualize, decide.

## Filters

- **Nitpick gravity.** Reviewers fill the space: with no critical issues, they inflate nits. If a reviewer's findings are all nits and style preferences, the code is probably fine. Say so.
- **Hypothetical versus actual.** "What if someone passes null here?" is a finding only if a caller can pass null. Trace the call site. If the input is validated upstream or the types prevent it, dismiss it.
- **Premature abstraction.** For a suggested extraction, interface or abstraction, ask whether this code needs to change in a second way. If not, simple inline code wins.
- **"I would have done it differently."** The most common false positive. A preference with no concrete problem shown is not actionable. Dismiss it and say why.
- **Missing context.** Findings about code the author did not touch, flags on patterns consistent with the rest of the codebase, advice that conflicts with constraints you know. Dismiss these gracefully.

## When reviewers are right

Do not dismiss a finding because it is uncomfortable. It deserves attention when:

- Reviewers raised it independently, above all reviewers from different model families.
- It shows a concrete execution path, not a hypothetical.
- It reveals a gap in your model of the code.
- You read it and think "...yeah, actually".

A lone security or correctness finding gets more scrutiny before dismissal, not less. If you wrote the change, you are biased toward it: every dismissal needs a concrete reason the user can check (a `file:line`, a type, a traced caller).

## Calibration

A good verdict is useful, not comprehensive: the user reads Act on, fixes those, and ships with confidence. If an axis's Act on list has more than 5 items, you are probably not filtering hard enough.

The Dismissed section is not busywork. It is a trust mechanism: showing what you rejected and why lets the user override your judgment where they disagree.
