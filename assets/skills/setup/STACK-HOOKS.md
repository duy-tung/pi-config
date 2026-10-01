# Stack hooks

Say this once, before proposing: a mistake the agent repeats becomes a type, a lint rule or a hook before it becomes prose.

Destructive git commands and hook bypasses such as `--no-verify` are already blocked by pi-config's git guard. Do not add a per-repo copy. There is no allow-rule step: Pi has no project allow rules, and auto mode already runs read-only and test commands.

## 1. Commit-time hooks

Commit-time hooks (husky with lint-staged, the pre-commit framework, a versioned `.githooks/`) remain the enforced layer for everyone: they run for every contributor and every harness, whatever the editor did.

Take the check commands from the repo, never from memory: manifest scripts, `Makefile` or `justfile` targets, the CI workflow.

| Stack | Example checks |
|---|---|
| JS/TS (pnpm shown) | `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` |
| Python (uv shown) | `uv run pyright`, `uv run ruff check`, `uv run ruff format`, `uv run pytest` |
| iOS | `swiftlint lint`, `make test` |
| Android | `./gradlew ktlintCheck`, `./gradlew detekt`, `./gradlew testDebugUnitTest` |
| Flutter | `dart format`, `flutter analyze`, `flutter test` |

When a check is a long command line (an `xcodebuild` with scheme and destination), wrap it in a make target or script first and call that.

Recommend the gate when the repo has no pre-commit hook and no CI job running its checks. Run each check on the current tree before wiring it: a gate that is red on a clean tree blocks every commit, so leave a red check out and tell the user. Keep the gate under about a minute; slower suites go to pre-push or CI.

### JS/TS: husky + lint-staged

1. Detect the package manager from the lockfile: `pnpm-lock.yaml` pnpm, `yarn.lock` yarn, `bun.lock` or `bun.lockb` bun, else npm.
2. Install `husky` and `lint-staged` as devDependencies. Add `prettier` only when the repo has no formatter, and then also write `.prettierrc`:
   ```json
   {"useTabs": false, "tabWidth": 2, "printWidth": 80, "singleQuote": false, "trailingComma": "es5", "semi": true, "arrowParens": "always"}
   ```
3. Run `npx husky init`. It creates `.husky/` and the `"prepare": "husky"` script.
4. Write `.husky/pre-commit` (Husky v9 needs no shebang) with `npm` replaced by the detected package manager, dropping a line whose script does not exist:
   ```
   npx lint-staged
   npm run typecheck
   npm run test
   ```
5. Write `.lintstagedrc` for the formatter the repo uses:

   | Repo uses | `.lintstagedrc` |
   |---|---|
   | prettier | `{"*": "prettier --ignore-unknown --write"}` |
   | prettier and eslint | `{"*.{js,jsx,ts,tsx,mjs,cjs}": ["eslint --fix", "prettier --write"], "*.{json,md,css,scss,yml,yaml}": "prettier --write"}` |
   | biome | `{"*.{js,jsx,ts,tsx,mjs,cjs,json,jsonc}": "biome check --write --no-errors-on-unmatched"}` |

6. Prove it: stage one changed file, run `npx lint-staged`, then `sh .husky/pre-commit`.

### Python: pre-commit framework

Mirror the tools CI already runs: in a black, isort or flake8 repo, use those hooks unless the user asks to switch to ruff. Replace `uv run` with the repo's runner (`poetry run`, or nothing), and use `mypy .` instead of `pyright` when the repo uses mypy. Write `.pre-commit-config.yaml`, run `pre-commit autoupdate` (pins each `rev` to the latest tag) and `pre-commit install`, then prove it with `pre-commit run --files <one changed file>`.

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.15.11
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
  - repo: local
    hooks:
      - id: typecheck
        name: typecheck
        entry: uv run pyright
        language: system
        types: [python]
        pass_filenames: false
      - id: tests
        name: tests
        entry: uv run pytest -q
        language: system
        pass_filenames: false
        always_run: true
```

### Mobile: a versioned git hook

Write `.githooks/pre-commit` with the platform's lint and unit test commands, `chmod +x` it, and run `git config core.hooksPath .githooks`. That setting is per clone: tell the user, or add it to the repo's bootstrap script. iOS shown:

```sh
#!/bin/sh
set -e
swiftlint lint --strict
make test
```

| Platform | Lint | Unit tests |
|---|---|---|
| iOS | `swiftlint lint --strict` | the repo's `make test` or `xcodebuild ... test` line |
| Android | `./gradlew ktlintCheck detekt` (tasks the build defines) | `./gradlew testDebugUnitTest` |
| Flutter | `dart format --output=none --set-exit-if-changed . && flutter analyze` | `flutter test` |

Simulator and emulator suites are too slow for pre-commit: put them in `.githooks/pre-push`.

## 2. Module boundaries (opt-in)

Offer; do not recommend by default. On yes:

- TypeScript: follow [BOUNDARIES.md](../../stack-skills/typescript/BOUNDARIES.md) of the `typescript` stack skill.
- Python: follow [BOUNDARIES.md](../../stack-skills/python/BOUNDARIES.md) of the `python` stack skill.
