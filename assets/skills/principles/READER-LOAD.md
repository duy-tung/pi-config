# P2. Minimize reader load

**Rule.** Maintainability is the work a reader must do to understand code. Track two independent axes: the layers to trace between a question and its answer, and the state the reader must hold in their head.

**Apply.**

- **Deep modules.** Prefer a small interface that hides a lot of implementation. Depth is a property of the interface, not the implementation. The vocabulary (module, interface, depth, seam, adapter, leverage, locality) is the `codebase-design` skill's.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through: inline it. If complexity reappears across its callers, it earns its keep.
- **Collapse layers that cost more than they save:** one-caller wrappers, pass-through methods, adapters with a single implementation. One adapter means a hypothetical seam; two adapters make a real one.
- **Adjacent layers must change the abstraction.** A layer that repeats the same methods and arguments adds load without compression.
- **Keep the call hierarchy flat.** If answering a question means tracing more than three files or layers, flatten it. A rich interface that hides substantial work is not a deep call chain.
- **Shrink state scope:** pure functions over locals, locals over fields, fields over module state, module state over globals. Derive values instead of syncing them.
- **Name the invariant once, at the interface,** not in every consumer.

**Test.** Can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or cut state.

> Before adding a layer or a piece of state, ask: does this reduce reader load somewhere else by at least as much?
