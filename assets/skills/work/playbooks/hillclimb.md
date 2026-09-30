# Hillclimb

**You own the metric and the experiment's integrity. Supervise and review. Delegate the attempts.** For sustained improvement of one measurable thing toward a target. A one-off fix is [perf.md](perf.md) or [bug.md](bug.md).

Core discipline: one change, one measurement, keep or revert. Never stack untested changes. Never claim a win from code inspection.

1. **Ground the workload.** Load the `how` skill and run it over the target. Name the workload dimensions that can move the result (data size, history, state, concurrency) and pick a case that reproduces the complaint. If no case reproduces it, fix the repro before climbing. Fix one metric, the direction that counts as better, and a stop predicate that pairs a target with a floor on attempts ("at least 50% better than baseline and at least 10 iterations"). Use the user's numbers, or agree them.
2. **Build the harness, prove its sensitivity, freeze it.** Contrasting workloads must separate as expected; if they do not, revise the workload or metric. Once frozen, one command emits the metric as the median of N runs. Record the baseline and a green run of the regression gate (the tests that must keep passing) before any change.
3. **Open the log.** Load the `decision-log` skill. One row per attempt: hypothesis, change, before, after, delta, tests, kept or reverted. Read it before each attempt.
4. **Name a mechanism** for each hypothesis ("defer X off the boot path because it blocks first paint"), not "try memoizing something".
5. **Loop, one hypothesis per iteration.**
   - Hand the change to a `worker` agent with a tight scope, or make a one-line change yourself. Independent hypotheses may fan out to parallel workers, each with `isolation: worktree`, only when the project enabled worktree isolation (`.pi/subagents.json` `worktreeIsolation: true`); otherwise run them one at a time, each on its own branch.
   - Measure before and after with the frozen harness; a long benchmark run goes through `bg_run` with `triggerOnCompletion: true`, never a sleep loop. Run the regression gate.
   - Keep only when the metric moves past noise and the gate stays green. Otherwise revert in full.
   - One commit per accepted change, named files only (`git add <files>`, never `-A`). Log the row either way.
6. **Push past the first plateau.** After several rejects in a row: pivot category, combine near-misses, re-read the source, try something more radical. Correctness and simplicity outrank the number: revert a win that breaks behavior, keep a simplification that holds the number.
7. **Stop** when the predicate is met, or when the remaining ideas are marginal. Never relax the predicate to meet it. Do not quit while cheap untried hypotheses remain. Surface a dead end instead of spinning. For an unattended climb, tell the user to run it under `/skill:afk`.
8. **Next.** Tell the user `/skill:ship` opens a PR with the accepted commits in the order they landed.

**Reply:** metric and target, baseline to final with the percent delta, iterations run (kept vs reverted), each accepted change in one line, the decision log path, and the next idea you would try.
