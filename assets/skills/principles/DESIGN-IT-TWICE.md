# P7. Design it twice

**Rule.** When a design decision has no precedent in the codebase, build two or three structurally different candidates and compare them side by side before committing.

**Applies to:** novel UI interactions; architectural choices with several viable approaches; product decisions that depend on feel rather than logic.

**Does not apply to:** mechanical work with an established pattern; bug fixes or refactors with a clear target; changes where the constraints leave one viable approach.

**Apply.**

- Candidates are whole-shape alternatives, not point fixes inside one shape.
- For interfaces and module shape, use the design-it-twice method in the `codebase-design` skill. For behavior or UI feel, build throwaway candidates with the `prototype` skill.
- Compare on the criteria that matter (depth, locality, the consumer's usage), then pick one. Do not average the candidates into a safe-looking middle.

**Test.** Are the candidates different shapes, or flavors of one shape? A second flavor of the first shape does not count.

> Building the wrong thing costs more than exploring three options.
