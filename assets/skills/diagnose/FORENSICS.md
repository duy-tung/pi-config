# Forensics

The deliverable is a cited diagnosis, not a fix. Fix only when asked. Once the cause is known, return to Phase 5 of the main loop for a bug, or to [PERF.md](PERF.md) for slowness.

Parse large artifacts in a `researcher` agent (its read-only bash runs `jq`) and keep only the reduced finding in the main thread.

## Live process

Instrument the running process. Do not theorize from source.

1. **Capture the live signal** on the surface where the symptom shows: a CPU profile for a spinning process, a heap snapshot for a leak, a performance trace for a visual glitch. A real artifact, not a guess.
2. **Reduce it to the smoking gun:** the function on the hot path, the retainer chain from the leaked object to a GC root, the loop that fires without input.
3. **Prove the mechanism before believing it.** Confirm it cheaply in the live process: evaluate an expression through the debugger or the DevTools protocol, set a breakpoint, or hotfix the running code without a reload.
4. **Map it to source:** file, symbol, and the line that allocates or schedules.

## Captured artifact

The capture already exists. It is a fixed dataset: read it, do not rerun it.

1. **Identify the format** and load it with the right tool: a DevTools or trace parser for `.cpuprofile` and `.json.gz` traces, heap tooling for `.heapsnapshot` and `.hprof`, a text editor for a spindump.
2. **Reach a queryable shape before you read.** Dump the artifact into sqlite, one row per sample, frame or node, or query the JSON in place with `jq`. A `.cpuprofile` is JSON with `nodes`, `samples` and `timeDeltas`; a Chrome trace is a `traceEvents` array. A short script loads either.
3. **Narrow to the cause.** Query for the frames holding the most self time, then walk the call tree to the hot path. For a leak, follow the retainer chain to a GC root. For a spindump, find the thread that is on CPU or blocked, and its wait reason.
4. **Attribute to source** through the artifact's own symbols: source maps, dSYMs, ProGuard or R8 mapping files. A frame without source mapping is not a diagnosis. Resolve the symbols, or say plainly that the artifact does not carry them.
5. **Confirm against a paired capture** (before and after) when you have one. Without one, label the finding as the strongest hypothesis the artifact supports, not a confirmed cause.

## Capture tools

| Platform | Capture |
|---|---|
| Node | `node --cpu-prof` (CPU); `node --heapsnapshot-signal=SIGUSR2`, then `kill -USR2 <pid>` (heap); `node --inspect` for the DevTools protocol (live). |
| Browser, Electron | DevTools protocol: the `Profiler` domain (CPU), `HeapProfiler.takeHeapSnapshot` (heap), the `Tracing` domain (timeline). |
| Python | `py-spy record --pid <pid>` (CPU), `py-spy dump --pid <pid>` (stuck process), `tracemalloc` snapshots (memory). |
| iOS, macOS | `xcrun xctrace record` with the Time Profiler, Allocations or Leaks template; `sample <pid>` and `spindump` on macOS. |
| Android | Perfetto or `simpleperf` (CPU, timeline); `adb shell am dumpheap <pid> <file>` (heap). |

## Reply

The signal or artifact and its format, the reduced finding, how the mechanism was proven (or "strongest hypothesis, no paired capture"), the source location, and the artifact paths.
