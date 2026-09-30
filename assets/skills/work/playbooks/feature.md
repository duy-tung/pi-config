# Feature

**You own the design. Align, build in verified units, prove, review.**

1. **Align.** If this was not grilled already, load the `grilling` skill (and `domain-modeling` when the repo keeps a CONTEXT.md). Settle observable forks with the `prototype` skill. Do not build until the user confirms shared understanding.
2. **Size it.** Fits in one smart zone (about 150k tokens including the build)? Continue here. Bigger: stop and tell the user to run `/skill:to-spec`, then `/skill:to-tickets`, then `/skill:implement <ticket>` per ticket. Keep this window unbroken until the tickets exist.
3. **Ground.** Load the `how` skill and run it over each subsystem you will touch. Naming a file is not grounding.
4. **Throughput checkpoint.** Write four todos. One that does not apply stays as `n/a: <reason>`:
   - Blocking first steps: what must land before anything can run in parallel.
   - Independent workstreams: disjoint files or layers that can run in parallel: `worker` agents build, `explorer` agents read code, `researcher` agents read docs and the web.
   - Shared mutable state: split it first; serialize only for a real invariant.
   - Smallest safe decomposition: if one owner is best, say why.
5. **Build** by following [build.md](build.md).
6. **Next.** Tell the user `/skill:ship` opens the PR.

**Reply:** what you built, the data shape and why, the throughput checkpoint, the verdict with evidence, review items still open, open decisions. Tables for design alternatives.
