# P4. Parse at the system boundary, make illegal states unrepresentable

**Rule.** Validate, parse and handle errors where data enters the process: CLI args, config, environment, network, database rows, IPC, files. Inside, trust the types. The type checker is a proof assistant: shape the types so impossible states do not compile.

**Apply.**

- **At the system boundary,** parse unstructured input into domain types with the repo's schema library and return errors there. **Inside,** pass typed data and propagate errors: no re-validation, no redundant null checks.
- Expose domain concepts through a public interface, never its wire, storage or framework types.
- Keep business logic in pure functions. The shell stays thin and mechanical.
- **Illegal states unrepresentable.** Model variants as sum types, not bags of optional fields. `{ completed: boolean; completedAt?: Date }` admits `completed: true` with no date; `{ kind: "open" } | { kind: "done"; at: Date }` does not.
- **Types are constructions.** A non-empty list is a head plus a rest. A valid range is a start plus a duration.
- **Brand semantic primitives.** A `UserId` and an `OrderId` are not interchangeable strings.
- **Do not lie to the compiler.** A cast is a latent crash. Prove the fact (validate, narrow, refine the model) or accept the hazard knowingly.
- **Exhaustive matches.** The compiler must fail when a new variant goes unhandled: `never` in TypeScript, `assert_never` in Python, a sealed `when` in Kotlin, a `switch` with no `default` in Swift.
- **Derive types from the authoritative schema** (OpenAPI, protobuf, GraphQL, migrations) instead of hand-rolling a parallel type.
- **Strengthen a type only where partiality appears.** A runtime assertion or a "should never happen" throw marks the spot. Push the check into the type, then stop.
- Language idioms: the `typescript`, `python` and `mobile` skills.

**Test.** Is this data crossing a system boundary right now? If not, validation is redundant. Can you write a comment explaining when this combination of fields is valid? If so, split it into a sum type. If a variant is added next month, will the compiler show the next agent every place to handle it?

> External data is untyped until parsed.
