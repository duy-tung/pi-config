# P12. Converge under retries and concurrency

**Rule.** Every state-changing operation converges to the correct end state however many times it runs and wherever a previous run stopped. Concurrent actors do not share a mutable write target unless one shared writer is a real invariant.

**Apply.**

- **Idempotency.** Convergent startup: scan existing state, clean stale artifacts, adopt live sessions. Clean up by content, not creation order. Detect stale locks by PID. Failed work respawns cleanly.
- **Before sharing state, ask** what happens if another actor modifies it concurrently. If the answer is not "nothing", isolate.
- **Eliminate the shared write target first.** Give each actor its own file, key, branch or state directory, and merge only where the results are read. Two workers writing their own `lastX` field into one `state.json` is still shared mutation; `indexer-state.json` beside `metrics-state.json` is not.
- **Serialize structurally only when one shared writer is a real invariant:** a lockfile, sequential phases, a single-writer actor, compare-and-swap. Treat "we need a lock" as a smell to check, not a default.
- The same holds for agents: parallel workers each get their own worktree, branch or output file.

**Test.** What happens if it runs twice in a row? If the previous run crashed at every possible point? Does it converge to the same end state? If any answer is "it depends on what state was left behind", add a reconciliation step.

> Instructions and conventions are not concurrency control.
