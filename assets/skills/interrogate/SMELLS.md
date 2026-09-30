# Standards baseline

The standards axis applies this baseline on top of the repo's documented standards. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins. Where the repo endorses something this baseline would flag, suppress the flag.
- **Always a judgement call.** Every baseline flag is a labelled heuristic ("possible Feature Envy"), never a hard violation. Skip anything tooling already enforces: lint, formatter, type checker, pre-commit hooks.

## Fowler smells (Refactoring, chapter 3)

Each reads: what it is, then the fix.

- **Mysterious Name.** A name that does not reveal what it does or holds. Rename it; if no honest name comes, the design is murky.
- **Duplicated Code.** The same logic shape in more than one hunk or file. Extract the shared shape and call it from both.
- **Feature Envy.** A method that reaches into another object's data more than its own. Move it onto the data it envies.
- **Data Clumps.** The same few fields or params travel together. Bundle them into one type.
- **Primitive Obsession.** A primitive or string standing in for a domain concept. Give the concept its own small type.
- **Repeated Switches.** The same switch or if-cascade on the same type recurs. Use polymorphism, or one map both sites share.
- **Shotgun Surgery.** One logical change forces scattered edits across many files. Gather what changes together into one module.
- **Divergent Change.** One module edited for several unrelated reasons. Split it so each module changes for one reason.
- **Speculative Generality.** Abstraction, parameters or hooks for needs the spec does not have. Delete it; inline it back until a real need shows.
- **Message Chains.** Long `a.b().c().d()` navigation the caller should not depend on. Hide the walk behind one method on the first object.
- **Middle Man.** A class or function that mostly delegates onward. Cut it and call the real target.
- **Refused Bequest.** A subclass that ignores or overrides most of what it inherits. Drop the inheritance and compose.

## Comments

A comment in the diff survives only in one of these cases:

1. A license or legal header.
2. Non-obvious behavior forced by something we cannot change: an external dependency, platform, vendor or protocol. A surprise in our own code is not a keep: flag the exact symbol for the rename, extract, type or redesign that makes the behavior obvious without prose.
3. A doc comment that defines a public API contract.
4. An issue or RFC link that explains a constraint code cannot express.
5. A lint suppression whose rule is style-only, pedantic or wrong for this line, such as `// prettier-ignore`. A suppression of a rule that protects correctness or safety (`@ts-ignore`, `@ts-expect-error`, a disabled correctness rule, `# type: ignore`, `# noqa` on a security rule) is a finding: fix the code it hides.

Flag everything else:

- Narration that restates the code, banners, phase comments in scripts.
- Commented-out code.
- Workaround sermons. A long justification is a sign the code is wrong: suggest the fix, not a shorter comment.
- Constraint notes ("do not remove", "do not change wording", "IMPORTANT", "talk to X first"). Suggest the cheapest encoding that enforces the constraint instead: a type, a test, a lint rule or a runtime check. If you cannot tell whether the claim is still true, say so.

When unsure whether a keep case applies, flag it.

## Code quality

Be ambitious about structure. Look for a code judo move: a restructuring that keeps behavior and makes whole branches, modes, helpers or layers disappear. Deleting complexity beats rearranging it.

- **The 1000-line rule.** A diff that pushes a file from under 1000 lines to over 1000 needs a very strong reason. Suggest extracting helpers, subcomponents or modules first.
- **No spaghetti growth.** New ad-hoc conditionals, scattered special cases and one-off branches in unrelated flows are a design problem, not a style nit. Push the logic into a dedicated helper, state machine or module.
- **Clean the design, not just the code.** When behavior can stay the same while the structure gets meaningfully cleaner, push for it. Prefer removing moving pieces over spreading the same complexity around.
- **Boring over magic.** Flag brittle, ad-hoc or magical behavior, generic mechanisms that hide simple data-shape assumptions, identity wrappers and pass-through helpers.
- **Types and interfaces.** Question needless optionality, `any`, `unknown` and casts where a clearer type could exist, and silent fallbacks that paper over an unclear invariant.
- **Canonical layer.** Flag feature logic leaking into shared paths, implementation details leaking through APIs, and one-offs that duplicate an existing helper.
- **Orchestration.** Flag independent work serialized for no reason, and related updates that can leave state half-applied.

Label these strong judgement calls, presumptive blockers unless the author justifies them: a code judo move would delete much of the diff's incidental complexity; a file crosses 1000 lines; ad-hoc branching tangles an existing flow; feature checks scattered across shared code; an unnecessary wrapper or a cast-heavy contract; a duplicated helper or logic in the wrong layer. Do not soften a major maintainability problem into a mild suggestion.
