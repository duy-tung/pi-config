---
name: typescript
description: "TypeScript type discipline: discriminated unions, brands, schema parsing at the boundary, exhaustive never checks, no as casts. Use when writing, reviewing or designing TypeScript types."
---

# TypeScript

The type checker is a proof assistant. Make illegal states unrepresentable, parse external data once where it enters, and trust the types inside. This is P4 (parse at the system boundary) from the `principles` skill, in TypeScript syntax.

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states can't be represented. No optional-field bags. |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` so they can't be mixed up. Validate once at the boundary. |
| Constructive modeling | Build the shape so the illegal value can't be constructed. `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `durationMs` for a range. Not a runtime guard, not a wish for refinement types. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to `NonEmpty<T>` only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. |
| Schemas before guards | Before hand-writing a property-by-property type guard, use the repository's runtime schema library and infer the type from the schema, such as `z.infer`. |
| No `as` casts | Every `as` is a runtime crash waiting. Cast only after validation. |
| Narrowing hierarchy | Discriminant switch > `in` operator > `typeof` or `instanceof` > user-defined type guard > `as`. |
| Type guards | Must verify the claim. A lying guard is worse than `as` because the bug hides behind a name that says it's safe. Name them `isX` or `hasX`. |
| Exhaustiveness | Inline `const _exhaustive: never = x;` in default arms so the compiler errors when a new variant is added. |
| `satisfies` over `as` | Validates the value without widening literal types. |
| Boundary validation | Parse where data crosses in, into a named domain type. `Record<string, unknown>` (however spelled) stops at that parse. Trust types inside. |
| Schema-derived types | Reach for `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, and `typeof` before declaring a new interface. |
| Object args | Pass objects, not positional arguments, so argument order is self-documenting. Skip on hot paths (per-frame render, tokenizers, parsers). |
| Real tests | Don't mock what you can run. Prefer the framework's real test primitives with leak and disposable checks, and verify UI in a running build through the repo's verify skill. Mock only what you can't run locally. |
| Structured telemetry | Prefer structured logger diagnostics with enough context to debug from an id. No `console.log` in shipped code. |

Examples for every rule: [PATTERNS.md](PATTERNS.md).

To enforce package entry points and ban import cycles with dependency-cruiser, follow [BOUNDARIES.md](BOUNDARIES.md). Run it only when the user asks for boundary enforcement: it adds a dev dependency and a CI check.
