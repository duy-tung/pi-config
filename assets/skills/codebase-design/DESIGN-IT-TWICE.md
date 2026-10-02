# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, or [ARCHITECT.md](ARCHITECT.md) needs candidates, use this parallel subagent pattern. Based on "Design It Twice" (Ousterhout): your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md): **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before spawning subagents, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints, not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the subagents work in parallel.

### 2. Spawn subagents

Produce 3+ candidates. Each must be a **radically different** interface for the deepened module. Seat them in roles on different models, so their blind spots differ (AGENTS.md lists each role's model): by default one `researcher` agent, one `reviewer` agent, and your own design. When a role runs your own model, only its constraint sets its candidate apart: say so when you present it. Add a `worker` agent when a candidate needs code to run before it can be judged. Spawn the agents in one response (parallel Agent calls). Write your own candidate before you collect theirs with `get_subagent_result`, so it stays independent.

Prompt each subagent with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each seat, yours included, a different design constraint:

- Seat 1: "Minimize the interface: aim for 1 to 3 entry points max. Maximise leverage per entry point."
- Seat 2: "Maximise flexibility: support many use cases and extension."
- Seat 3: "Optimise for the most common caller: make the default case trivial."
- Seat 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Point each brief at this skill's `SKILL.md` and `DEEPENING.md` by absolute path (resolved from this skill's location) and at the repo's `CONTEXT.md`, so each subagent names things consistently with the architecture language and the project's domain language. End each brief with: "Do not spawn agents or run user-invoked skills. Do the work directly."

Each candidate outputs:

1. Interface (types, methods, params, plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs: where leverage is high, where it's thin

### 3. Present and compare

Present designs sequentially so the user can absorb each one, each labelled with the role that produced it, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**. When two seats share a model family (all of them do under the `claude` preset), say so: their blind spots are correlated.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated: the user wants a strong read, not a menu.
