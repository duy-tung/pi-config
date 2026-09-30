# Figure it out

**No playbook fits. Design one before any code:** phases that scale rigor to the task, run the scientific method, and leave a trail a human can audit.

**A. Frame.** State before starting:

- Done as a falsifiable predicate.
- Scope, quantified: units, effort, the blockers grounding surfaced.
- The rigor level, biased high for one-way doors and a wide blast radius. Rigor is gates and artifacts, not "try harder".

Present the framing before a long run. Reversible work proceeds without asking, but a multi-hour run earns one checkpoint with the user.

**B. Design.** Decompose into atomic, independently landable units. Riskiest unknown first. Scaffold and verification come before features:

- Build the verification harness before the work, with a baseline from the pre-change state, so every check reads "old value versus new value".
- Use the `codebase-design` skill only for one-way-door design decisions. A second design pass over a settled shape is over-engineering.
- Fan out only across seams, each worker in its own worktree when the project enabled worktree isolation (`.pi/subagents.json` `worktreeIsolation: true`). Otherwise run the units one at a time on one branch.
- Write the phase list down and add its steps to the `todo` list. That list is what the human reviews.

**C. Loop.** Each unit is an experiment: hypothesis, smallest change, measure on the real artifact, keep or revert. Verify each unit before the next.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
- Pair delegated work with a checker. If a worker games a gate, harden the contract. If the gate itself is wrong, fix the gate in its own change.
- A verdict is VERIFIED, NOT VERIFIED or INCONCLUSIVE. Inconclusive is not a pass. Do not hide a negative.

**D. Trail.** Load the `decision-log` skill and add a row as each step lands.

**E. Verify and hand back.** Check the whole against the predicate on the real product: load the `prove` skill. Encode each recurring correction as a gate, lint rule, check or script.

**Reply:** the playbook you designed, the rigor level and why, the trail path, what is verified against the predicate, what is still open.
