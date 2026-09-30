# P3. Data first, model the domain

**Rule.** Get the data shape right before writing logic, and encode the domain in a structure instead of scattering it across conditionals. The right structure makes the downstream code obvious.

**Apply.**

- Before any code, name the data shape and the structure that organizes it. Define core types early, trace every access pattern, and pick structures that match the dominant paths.
- Reach for the structure the domain has:
  - a state machine instead of scattered booleans, phases or lifecycle checks;
  - a typed model instead of loose parameters or repeated shape assumptions;
  - a map, registry, lookup table or discriminated union instead of branching spread across files;
  - a reducer or command and event model instead of ad hoc mutation;
  - a module organized around one body of domain knowledge, not around a sequence such as load, validate, transform, save.
- **Ubiquitous language.** Name types, modules, functions and tests with the terms in `CONTEXT.md`. When a concept has no settled term, settle it with the user (the `domain-modeling` skill) before you encode it.
- Each increment lands a coherent abstraction or deepens one that exists. Do not spread a new capability across callers as special-case coordination.
- DRY the structure, not every line. Three similar statements beat a premature abstraction.
- Do not force an abstraction. Boring code wins when the current shape is clear, local and unlikely to grow. Be skeptical of a structure that adds indirection without removing branches, duplicated rules, invalid states or lifecycle risk.

**Smell.** A new feature grows an existing if/else chain by one more branch, a second boolean must stay in sync with the first, or phase-named modules repeat the same domain rules.

**Test.** Can you state the data shape and its organizing structure in one sentence before writing logic?

> Execution order is not ownership.
