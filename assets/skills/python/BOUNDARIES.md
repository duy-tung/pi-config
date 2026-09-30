# Package boundaries with import-linter (opt-in)

Run this recipe only when the user asks to enforce package boundaries. It is the Python counterpart of the TypeScript dependency-cruiser recipe. Every package becomes a **deep module**: a lot of behavior behind a small interface. A package's interface is its root modules; its implementation lives in a private `_internal` subpackage. [import-linter](https://github.com/seddonym/import-linter) checks the contracts, and the recipe ends by proving they bite.

For the vocabulary (deep module, interface, seam, depth), load the `codebase-design` skill.

## The shape this enforces

```
src/shop/
  billing/
    __init__.py     <- an entry point (public). Import this from outside.
    client.py       <- another entry point. Packages may expose several.
    _internal/      <- implementation: private to billing, free to import itself.
  orders/
    ...
tests/
  __init__.py       <- tests form a package, so contracts can see them.
```

Four kinds of contract:

1. **One `protected` contract per package.** Only the package itself may import its `_internal` subpackage. import-linter has no back-references, so no single contract can say "each package may import only its own internals". Adding a package means adding its contract.
2. **`tests use public entry points only`.** A `forbidden` contract: tests may not import any `_internal` subpackage. It sets `allow_indirect_imports = true`, so a test may call an entry point that uses internals.
3. **`no cycles between packages`.** An `acyclic_siblings` contract over the root package.
4. **Layering** (which packages may depend on which) is a separate concern. Add a `layers` contract when the repo wants one.

The leading underscore also tells every reader the subpackage is private.

## Steps

### 1. Detect the environment

- **Runner.** `uv.lock` means `uv run`, `poetry.lock` means `poetry run`, else the project's virtualenv. Use it for every command below.
- **Root package and packages.** Find the importable root (`src/<app>/` or `<app>/`) and its immediate subpackages. Confirm with the user if the layout is unusual.
- **Tests.** Contracts see tests only when `tests` is an importable package (`tests/__init__.py`, run from the repo root). If the repo keeps tests as loose modules, leave `tests` out of `root_packages` and drop the tests contract.
- **Existing config.** Check for `[tool.importlinter]` in `pyproject.toml`, or a `.importlinter` or `setup.cfg` section. If one exists, merge the contracts in and tell the user what you added.

**Done when:** the runner, root package, package list, test layout, and existing-config status are all known.

### 2. Install import-linter

Add `import-linter` as a dev dependency with the repo's tool (`uv add --dev import-linter`, `poetry add --group dev import-linter`, or the dev requirements file).

**Done when:** `import-linter` is in the dev dependencies and `lint-imports --help` runs in the project environment.

### 3. Write the contracts

In `pyproject.toml`, one `protected` contract per package, plus the tests and cycle contracts:

```toml
[tool.importlinter]
root_packages = ["shop", "tests"]

[[tool.importlinter.contracts]]
name = "billing internals are private"
type = "protected"
protected_modules = ["shop.billing._internal"]
allowed_importers = ["shop.billing"]

[[tool.importlinter.contracts]]
name = "orders internals are private"
type = "protected"
protected_modules = ["shop.orders._internal"]
allowed_importers = ["shop.orders"]

[[tool.importlinter.contracts]]
name = "tests use public entry points only"
type = "forbidden"
source_modules = ["tests"]
forbidden_modules = ["shop.*._internal"]
allow_indirect_imports = true

[[tool.importlinter.contracts]]
name = "no cycles between packages"
type = "acyclic_siblings"
ancestors = ["shop"]
```

**Done when:** every package has a `protected` contract, and the tests and cycle contracts are present.

### 4. Wire it into the checks

- Add `lint-imports` to the repo's umbrella check, next to the type checker: a Makefile target, a nox or tox session, a pre-commit hook, or the CI step that runs pyright or mypy.
- import-linter imports the root package, so run it in the project environment (`uv run lint-imports`) with the package installed, or with `PYTHONPATH=src` for a src layout.

**Done when:** `lint-imports` runs as part of the same command as the type check.

### 5. Scaffold the example package

Create a committed `<root>/example/` as a copy-me template:

- `__init__.py` exports one function that delegates to `_internal/impl.py`, so the package is visibly deep, not a pass-through.
- `_internal/__init__.py` and `_internal/impl.py` hold the implementation.
- `tests/test_example.py` imports **only** `<root>.example` and asserts against the public function.
- Add the example's `protected` contract.

Tell the user this is a starter template to copy or delete.

**Done when:** the example package exists, exposes its behavior through its root module, and hides `impl` in `_internal`.

### 6. Prove the rules bite

This is the completion criterion for the whole recipe: a contract that doesn't fail on a violation is worthless.

1. Run `lint-imports`. It must pass, with "Analyzed N files" above zero and every contract `KEPT`. Zero files means import-linter found nothing to analyze: the pass is fake.
2. Add `from <root>.example._internal.impl import <name>` to a test. Run again; it must fail with `tests use public entry points only` `BROKEN`.
3. Revert that, and add the same deep import to a module in another package. Run again; it must fail the example's `protected` contract.
4. Revert. Run once more, and it must pass.

**Done when:** you have observed a pass with a nonzero file count, both failures, and a final pass. If a deep import does not fail, the contracts are not wired correctly: fix before finishing.

### 7. Document the convention

Write a `README.md` next to the packages it governs (for example `src/shop/README.md`): the layout (entry points at the package root, implementation in `_internal/`), "import only through a package's root modules", "adding a package means adding its `protected` contract", and how to run `lint-imports`.

Then add a context pointer to it from the repo's agent instructions file (AGENTS.md, or CLAUDE.md if that is the file the repo uses). One line is enough, for example: `Packages are deep modules: read src/shop/README.md before adding or importing one.`

**Done when:** the packages README exists, and the agent instructions file links to it.
