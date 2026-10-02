# Performance regressions

Tie every fix to a measurement. Do not read source instead of measuring, and do not claim a ceiling you have not run.

## Baseline first (Phase 1)

Before any theory, capture a baseline on the surface where the user feels the slowness:

- **A timing harness:** one repeatable command that prints the metric, sampled enough to clear the noise (median of N runs, never a single run). Record N, what one sample is, the machine and the data.
- **A profile or trace of the slow path:** a CPU profile, a browser performance trace, a query plan (`EXPLAIN ANALYZE`), a flame graph. [FORENSICS.md](FORENSICS.md) lists capture tools per platform.

The Phase 1 criteria still hold: the harness goes red (over budget) on the user's case, deterministically enough to compare, and runs unattended. Run a benchmark that takes minutes through `bg_run` with `triggerOnCompletion: true` and end your turn; Pi wakes you when it finishes.

## Hypotheses from eight strategy families (Phase 3)

Ground the hot path first (load the `how` skill), then use these families as hypothesis generators, not a checklist. A family earns an attempt only when the trace shows the signal it names.

| Family | Signal | Move |
|---|---|---|
| Elimination | Work nobody consumes: an always-off gate, a sync that mirrors state redundantly, a legacy path kept "just in case". The trace shows what is slow, never that it is deletable, so this needs the `how` pass, not the profiler. | Delete the work. |
| Divide and conquer | The dominant cost scales with input size. | Chunk, shard or prune so each piece touches less, or run independent pieces in parallel. |
| Caching | The same computation or fetch repeats on identical inputs. | Store and reuse the result. Name what invalidates the cache before claiming the win. |
| Indirection | The hot path does expensive work a cheaper intermediate could absorb. | An index instead of a scan, a queue off the interactive thread, a cheaper implementation behind a handle. Add the hop only when it removes more from the critical path than it adds. |
| Batching | Many small operations each pay a fixed overhead (RPC, query, syscall, draw call). | Coalesce them so the overhead is paid once per batch. |
| Redundancy | The wait hangs on one slow instance or attempt, and the system has headroom. | Replicas, hedged requests or speculative execution; take the fastest result. |
| Lazy evaluation | Cost lands on results that are unused or not needed yet: eager init on boot, offscreen rendering. | Defer the work to first use. |
| Scheduling | The work must happen, but not while someone waits. | Move it to idle time, a background warmup, a precompute, or after the frame commits. Measure the interactive path, not total work. |

## One change, one measurement (Phases 4 and 5)

- Try one hypothesis at a time: change, measure with the same harness, run the tests, keep or revert. Never stack untested changes.
- Keep a change only when the metric moves past the noise and the tests stay green. Revert anything that did not move it.
- Capture a post-fix profile and compare artifacts, not impressions: parse both (JSON into sqlite), then diff. Inconclusive or wrong-surface is not a pass.
- Correctness beats the number: revert a win that breaks behavior.

## Reply

The baseline number, the post-fix number, the delta, the method (N, what one sample is, machine, data), and the artifact paths. Cite the measurement in the commit or PR.

Sustained improvement of one metric toward a target, across many attempts, is a different job: agree the target and the measurement with the user, then log every attempt and its result.
