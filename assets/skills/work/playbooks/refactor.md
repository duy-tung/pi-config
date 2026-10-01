# Refactor

**The structure changes. The behavior does not.** New behavior is [feature.md](feature.md). A real bug found on the way is split out to [bug.md](bug.md), after the structural change lands against the pinned contract.

1. **Pin the behavior first.** Load the `how` skill to learn the contract, then write a characterization test, snapshot or equivalence harness before any structure moves. Type check and lint are not a pin.
2. **Name the missing structure.** The reshape must delete branches or invalid states, not add indirection. Boring code stays when its shape is already clear and local.
3. **Name the target shape**: module layout, types and call graph as if built today. If it crosses a module boundary, load the `codebase-design` skill and follow its ARCHITECT.md.
4. **Subtract before you add.** Delete dead code, collapse one-caller wrappers, drop redundant validators and orphan references first.
5. **Move in small behavior-preserving steps**, each keeping the pin green. For an API reshape where you own every caller: migrate every caller and delete the old API in the same wave, with no shims and no parallel old and new paths. Callers you do not own, or a migration longer than one session: [wide-change.md](wide-change.md). For symbol-level moves, find every use with `rg` and let the typecheck confirm none were missed. Check every rename against strings, docs and back-references.
6. **Prove unchanged behavior** on the real artifact: load the `prove` skill and run it with the pin and an equivalence check (old versus new output on the same input).
7. **Keep it only if reader load dropped somewhere.** Otherwise revert it.
8. **Commit** as subtraction, then reshape, then cleanup. **Review**: load the `interrogate` skill and run it with `<commit before this work> fix`.

**Reply:** what changed shape, the pin, the equivalence proof, the reader-load delta, what shipped and what was reverted. No new behavior.
