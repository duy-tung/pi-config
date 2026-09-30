# Coding standards

Reviewers check every diff against these rules. A rule a machine can check belongs in a type, a lint rule or a hook instead; this file keeps the judgment calls.

1. **Comments.** Keep only: license headers; behavior forced by a dependency, platform or protocol we cannot change; formatter directives such as `// prettier-ignore`; doc comments that define a public API contract; issue or RFC links for a constraint code cannot express. Delete narration, banners and commented-out code.
2. **Constraints live in code.** A "do not remove" or "do not change" comment becomes a type, a test or a lint rule, and the comment goes.
3. **Lint suppressions.** A new `eslint-disable`, `# noqa`, `swiftlint:disable` or `@Suppress` is allowed only for a style-only rule. When the rule protects correctness, fix the code.
4. **Type escapes need a link.** `any`, `as` casts, `@ts-ignore` and `@ts-expect-error` (TypeScript), `cast()` and `# type: ignore` (Python), `as!` and `!!` (Swift, Kotlin) each need a linked issue saying why the type cannot be expressed. `as const` and `satisfies` are fine.
5. **Parse at the boundary.** External data (network, files, env, user input) is parsed once where it enters, into a domain type with the repo's schema library. Inside, trust the types: no re-validation.
6. **File size.** A change that pushes a file past about 1000 lines needs a strong reason stated in the PR.
7. **Tests.** Call the code through its public interface and assert a literal expected value. A test that would still pass if every imported function returned `undefined` is rewritten or deleted.
8. **Dead code dies in the same change.** When a change makes code, a flag or a compatibility path dead, that change deletes it: migrate the callers, then remove the old API.
9. **One paved path.** Use the existing helper or pattern. A second way to do the same thing is a finding.

When you see the agent do something you do not want, add a line here instead of telling the agent off.
