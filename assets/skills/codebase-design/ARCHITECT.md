# Architect

Design before implementing. Sketch the caller's usage first, then the types, signatures, and modules, with `not implemented` bodies and pseudocode. Build at least two candidates, synthesize one, then fill in code against it. If implementation proves the sketch wrong, throw it out and redesign.

Uses the vocabulary in [SKILL.md](SKILL.md). Track the phases with the `todo` tool, one entry per phase: Ground, Sketch, Agree, Implement, Scrap.

## 1. Ground

Build a real mental model of every system the new code touches: load the `how` skill and run it on each touched subsystem. Naming a file isn't grounding. `rg` for a module's exports and call sites shows its surface before you read its files. If the design redefines ownership or layering, also run the `why` skill on the existing shape, so its rationale becomes a constraint, not a guess.

Skip this phase only for greenfield work with no surrounding system to integrate.

## 2. Sketch

**Usage first.** Before any type, write the caller's view: the README or quickstart a consumer reads, plus two or three realistic call sites in their code (what they import, what they call, what comes back). The caller's experience is the spec. The types serve it. When the sketch and the usage disagree, reconcile the sketch to the usage, not the reverse.

**At least two candidates.** Produce at least two structurally distinct candidates before choosing, even when the first looks sufficient: whole-shape alternatives, not point fixes inside one shape. Run [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md) (candidates from roles on different models where the preset allows, each with a different constraint). For a small change, two `researcher` agents with the same grounding and different constraints are enough. Add these runner rules to every brief:

- Write the caller's usage and two or three call sites before the types; derive the type sketch from them.
- Data structures first. Trace each dominant access pattern through the proposed structure. If the answer is "we'll add a map / index / cache later," the structure is wrong.
- Prefer a small interface that pulls complexity into the implementation, even when the implementation gets harder. Keep transport and wire types off the interface: parse external data into domain types behind it.
- If two actors might both write the same state, ask what happens. If the answer isn't "nothing," give each actor its own state and merge where it is read.
- Make the structure readable from signatures alone: `not implemented` bodies, `// TODO` pseudocode for tricky logic, doc comments stating intent and invariants.
- Encode invariants in types first, runtime checks second, comments last. Validate where external data enters (CLI, config, network, API input) and trust types inside. Business logic as pure functions behind a thin shell.
- One source of truth per invariant: derive it, don't sync it. Ask what happens if an operation runs twice or crashes halfway.
- Short call chains: if tracing a flow takes more than three files, flatten it.
- Produce the best design you can, not a hedge against the others. Converging on a safe-looking middle defeats the exploration.

**Screen for red flags.** Revise or reject any candidate with one of these before choosing:

- **Shallow module**: a large interface hiding little. Tells: callers coordinate several methods to complete one operation; options expose internal stages or implementation choices; learning the interface does not save the caller from learning the implementation. A deep call chain is not a deep module: it scatters understanding across layers.
- **Information leakage**: several modules depend on one internal decision (a representation, policy, or protocol detail), so changing it needs coordinated edits. Re-exporting transport or wire types is leakage. Keep storage schemas, framework objects, and protocol details private.
- **Temporal decomposition**: modules split by execution order (load, validate, transform, save) instead of by the knowledge they own, repeating one representation and its invariants across several seams. Group by the decisions a module protects; methods that run at different times can share one module.
- **Pass-through method**: forwards the same arguments to a method of the same shape, adding a layer without hiding anything. Remove it, unless it adds policy, adaptation, or a distinct abstraction.

**Synthesize.** Read every candidate end to end. Compare them on depth criterion by criterion, not on feel: what each interface hides relative to its size. Pick as the base the candidate a future maintainer can extend most easily without breaking invariants. Graft one or two ideas from each other candidate by hand, keeping one mental model. If the candidates converge, ship the consensus. If they wildly diverge, Ground was under-specified: reframe and re-run rather than averaging the divergence.

## 3. Agree

Proceed with the synthesized sketch unless the user asked to see it first ("with checkpoint", "show me before implementing"). For adversarial pressure on the sketch before implementing, load the `interrogate` skill. Treat pushback on the shape, now or later, as Ground evidence: re-ground and re-sketch before writing more code.

## 4. Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract.

Surface every deviation instead of absorbing it. If a function needs a parameter the sketch did not anticipate, decide whether the sketch was wrong, a requirement was missed, or the implementation is overreaching, and say which.

## 5. Scrap when the architecture is wrong

If implementation keeps producing friction the sketch can't absorb, throw the sketch out. Don't bolt fixes onto a wrong design. Scrap on a pattern, not a single instance. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that each need a special-case branch.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent deviations of the same shape across the implementation.

A few edge cases don't condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When you scrap:

1. Load the `how` skill and run it on what has been built.
2. Redesign as if the new constraints had been day-one assumptions.
3. Subtract before adding. The new sketch should be smaller than the old one before it grows.
4. Return to Sketch.

## Outputs

The caller's usage first, then the type sketch derived from it: one file of new types and signatures for a small change, a module map plus type definitions for larger work. The rationale ships alongside: one page, sentence-case headings, no boilerplate.

```markdown
## Problem
One paragraph: what we are doing, what makes the shape non-obvious, and the
constraints Ground surfaced (types to interop with, callers we can't break,
invariants that cross the seam).

## Usage (caller's view)
Written before Shape. The quickstart the consumer reads, plus two or three
realistic call sites. Shape is derived from this; the two must agree.

## Shape
Data structures first, then how data flows through the signatures. The
load-bearing decisions; which invariants live in types; where validation
lives; what the design deliberately does not do. Judge depth explicitly:
what the interface hides, what stays exposed, and why it is no larger
than needed.

## Synthesis decision
Which candidate became the base and why, what was grafted from each other
candidate, what was rejected and why.

## Tradeoffs accepted
One bullet each: "we accept X in exchange for Y". Name anything a reader
might mistake for an oversight.

## Alternatives considered
Required. At least one concrete alternative shape, one line on why it lost,
judged on depth: the complexity it exposes and the complexity it hides.
Not flavours of the same shape. One is enough only when the constraints
forced the answer: "this was the only viable shape because...".

## Open questions and risks
Phrased as questions, so the human's answer is the resolution.

## Next implementation step
One sentence: the first thing to build against the sketch.
```
