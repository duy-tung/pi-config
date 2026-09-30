# Package boundaries with dependency-cruiser (opt-in)

Run this recipe only when the user asks to enforce package boundaries. It makes every package a **deep module**: a lot of behavior behind a small interface. A package's interface is its **entry points** (the files at the package root), and everything in its subfolders is hidden. The recipe installs [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) and rules that make the entry points the only way in, then proves the rules bite.

For the vocabulary (deep module, interface, seam, depth), load the `codebase-design` skill and use its language throughout.

## The shape this enforces

```
src/packages/
  <name>/
    index.ts        <- an entry point (public). Import this from outside.
    client.ts       <- another entry point. Packages may expose several.
    lib/            <- implementation: hidden from outside, free to import each other.
    tests/          <- co-located tests and fixtures (a subfolder, so private).
```

The public interface is the package's **root files**, not one designated `index.ts`. By convention implementation lives in `lib/` and tests in `tests/`, giving every package the same two-folder shape. The rule itself is general: anything in any subfolder is private, so you never extend the config to add a folder.

Five rules, all `error`:

1. **`entrypoint-boundary-from-app`.** Code outside every package may import a package's entry points, never anything in its subfolders.
2. **`entrypoint-boundary-across-packages`.** A package's own files import each other freely, but reach other packages only through their entry points.
3. **`tests-through-entrypoints`.** Files under `<pkg>/tests/` may import any package's entry points and their own `tests/` fixtures, but never any package's subfolder internals, not even their own. Integration tests across packages are fine; deep imports are not.
4. **`tests-folder-is-private`.** Only tests may import a `tests/` folder.
5. **`no-circular`.** No dependency cycles.

**Entry points, not a barrel.** Because the public interface is every root file, a package can expose several small entry points (`index.ts`, `client.ts`, `server.ts`) instead of funnelling everything through one giant `index.ts`. Barrel files that re-export a whole subtree are discouraged; keep entry points small and hide implementation in subfolders.

Layering (which packages may depend on which) is a different concern. It stays a commented stub in the config for the repo to fill in.

## Steps

### 1. Detect the environment

- **Package manager.** `pnpm-lock.yaml` means pnpm, `yarn.lock` yarn, `bun.lockb` or `bun.lock` bun, else npm. Use it for every command below.
- **Packages root.** If `src/` exists use `src/packages`, else `packages`. Confirm with the user if the repo already has a different obvious convention.
- **Existing config.** Check for a `.dependency-cruiser.*` file. If one exists, do **not** overwrite it: merge the five rules and the options in, and tell the user what you added.
- **TypeScript compiler.** Note the version of `typescript` in `devDependencies`. dependency-cruiser loads the TypeScript compiler API to parse `.ts` files; at the time of writing (dependency-cruiser 18) it cannot load TypeScript 7.

**Done when:** the package manager, packages root, existing-config status, and TypeScript version are all known.

### 2. Install dependency-cruiser

Install `dependency-cruiser` as a devDependency. If the repo is on TypeScript 7 or has no `typescript` package, also add `typescript@^6` as a devDependency for the cruiser.

**Done when:** `dependency-cruiser` and a TypeScript version it can load are in `devDependencies`.

### 3. Write the config

Write this to the repo root as `.dependency-cruiser.cjs` and set `PACKAGES_ROOT` to the root detected in step 1. The rules are path-depth based and extension-agnostic, so nothing else needs adapting.

```js
// @ts-check
// Deep-module enforcement for dependency-cruiser.
//
// Each package under the packages root is a deep module: a lot of behaviour
// behind a small interface. A package's public interface is its entry points:
// the files at the package root. Implementation lives in subfolders and is
// private (by convention `lib/` for implementation and `tests/` for tests,
// though any subfolder is private). A package may expose several small entry
// points (index.ts, client.ts, server.ts); prefer that over one giant barrel.
//
// The only thing you should ever need to edit here is PACKAGES_ROOT.

/** Where packages live. One immediate child dir per package (flat, no nesting). */
const PACKAGES_ROOT = "src/packages";

// --- derived patterns (no need to edit) -------------------------------------
const R = PACKAGES_ROOT;
/**
 * A package's private internals: anything nested inside a package subfolder.
 * The package's root files are its entry points and are NOT matched here:
 * they stay importable from outside.
 */
const PACKAGE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "entrypoint-boundary-from-app",
      comment:
        "App/root code may import a package's entry points (its root files), but nothing inside its subfolders.",
      severity: "error",
      from: { pathNot: `^${R}/` }, // importer is NOT inside any package
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: "entrypoint-boundary-across-packages",
      comment:
        "A package's own files import each other freely, but may reach OTHER packages only through their entry points, never their internals.",
      severity: "error",
      // importer is inside a package ($1), but is not a test file
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/`, // same package: intra-package freedom
      },
    },
    {
      name: "tests-through-entrypoints",
      comment:
        "A package's tests exercise it through its entry points like everyone else: they may import any package's entry points and their own tests/ fixtures, but never any package's internals, not even their own.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/tests/` }, // a test file, in package $1
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/tests/`, // own tests/ fixtures: allowed
      },
    },
    {
      name: "tests-folder-is-private",
      comment:
        "A package's tests/ folder is reachable only from tests: nothing else may import fixtures.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/tests/` }, // importer is not itself a test
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: "no-circular",
      comment: "No dependency cycles. Scope to `^${R}/` if you want to allow cycles outside packages.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // --- Layering (optional, off by default) ----------------------------------
    // Interface-hiding controls HOW you import (through the entry points).
    // Layering controls WHICH packages may depend on which. Add your own rules
    // here, for example:
    //
    // {
    //   name: "ui-may-not-depend-on-billing",
    //   severity: "error",
    //   from: { path: `^${R}/ui/` },
    //   to:   { path: `^${R}/billing/` },
    // },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
```

**Done when:** `.dependency-cruiser.cjs` exists with the correct `PACKAGES_ROOT` and all five forbidden rules.

### 4. Wire it into the checks

- Add a `lint:boundaries` script: `depcruise <packages-root>` (or `depcruise src`). dependency-cruiser picks up `.dependency-cruiser.cjs` from the repo root.
- Fold it into the repo's umbrella check command, the one that already runs typecheck (a `check`, `ci`, or `validate` script). Do **not** touch `tsconfig` or add path aliases.
- If there is no umbrella script, add `lint:boundaries` and tell the user to include it in CI.

**Done when:** `lint:boundaries` exists and runs as part of the same command as typecheck.

### 5. Scaffold the example package

Create a committed `<packages-root>/example/` as a copy-me template:

- `index.ts` is an entry point. It exports one function that delegates to an internal file, so the package is visibly deep, not a pass-through.
- `lib/impl.ts` is an internal file in a subfolder, imported by `index.ts` and not reachable from outside.
- `tests/example.test.ts` imports **only** `../index` (an entry point) and asserts against the public function.

Tell the user this is a starter template to copy or delete.

**Done when:** the example package exists, exposes its behavior through a root entry point, and hides `impl` in a subfolder.

### 6. Prove the rules bite

This is the completion criterion for the whole recipe: a config that doesn't fail on a violation is worthless.

1. Run `lint:boundaries`. It must **pass** on the clean example, and its summary must report more than zero modules cruised. `0 modules, 0 dependencies cruised` means dependency-cruiser found no TypeScript compiler it can load and parsed nothing: that pass is fake. Fix the TypeScript devDependency (step 2) and rerun.
2. Temporarily add a deep import to `tests/example.test.ts` (for example `import { impl } from "../lib/impl"`). Run `lint:boundaries` again; it must **fail** with `tests-through-entrypoints`.
3. Revert the deep import. Run once more, and it must **pass**.

**Done when:** you have observed a pass with a nonzero module count, then a fail on the deep import, then a pass again. If step 2 does not fail, the rules are not wired correctly: fix before finishing.

### 7. Document the convention

Write a `README.md` **in the packages folder** (`<packages-root>/README.md`, next to the packages it governs) covering the `<packages-root>/<name>/` layout (entry points at the root, `lib/` for implementation, `tests/` for tests), "import only through a package's entry points (its root files)", and how to run `lint:boundaries`. **Discourage barrel files** explicitly: expose several small entry points instead of re-exporting a whole subtree through one index. Keep it to the copy-me snippet plus the rules, one paragraph each.

Then add a context pointer to it from the repo's agent instructions file (AGENTS.md, or CLAUDE.md if that is the file the repo uses). One line is enough, for example: `Packages are deep modules: read src/packages/README.md before adding or importing one.` This is what makes an agent discover the boundary rule instead of tripping over it.

**Done when:** `<packages-root>/README.md` exists and discourages barrels, and the agent instructions file links to it.

## Notes

- The config's `$1` back-references (dependency-cruiser's group matching) are what let a package reach its own internals while outsiders can't. Don't flatten them into separate per-package rules.
- Public versus private is decided by **depth**: a package's root files are entry points; anything in a subfolder is private. The conventional subfolders are `lib/` and `tests/`, but the rules don't hardcode them, so a new folder never needs a config change. Adding an entry point is just adding a root file (no barrel).
- Packages are **flat**: one tier of immediate children under the root. A package's internals may nest as deep as you like; a package may not contain another package.
- Use `.cjs` (not `.js`) so the config's `module.exports` works even in `"type": "module"` repos.
