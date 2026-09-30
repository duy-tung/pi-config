# Notes verification map

This directory is the maintained source for verifying the user-facing behavior of Notes. Read the index before driving the app, then use the matching feature file as the recipe.

`control-notes` is this skill's helper at `.agents/skills/verify-notes/scripts/control-notes`. Its `launch`, `doctor`, and `cleanup` commands follow the skill's Launch, Doctor, and Cleanup sections. `browser` drives Playwright against this run's instance. `cli -- <command>` runs a command in this run's isolated environment and records its stdout, stderr, and exit code.

## Baseline preconditions

- Launch Notes with `control-notes launch`. It picks a free port, sets `NOTES_DATA_DIR` to a data directory in this run's scratch space so concurrent runs do not share state, and prints `RUN_ID`, `NOTES_URL`, and `EVIDENCE`.
- Seed notes titled `Quarterly plan` and `Grocery list`.
- Put `control-notes` and the `notes` CLI on `PATH`.
- Run `control-notes doctor` and require the expected URL, data directory, and build revision.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `control-notes browser`.
- Run terminal actions through `control-notes cli -- <command>`.
- Restore seeded data after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the app identity visible.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a read-only second view of the stored value.
- Write artifacts under `$EVIDENCE/<feature>/`, which survives cleanup.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior. Include the states worth proving when they apply: empty, loading, error, disabled.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Create a note](./create-note.md) covers browser and CLI creation, cancellation, persistence, and cleanup.
- [Search notes](./search.md) covers toolbar, keyboard, and CLI search with matching, empty, and clear states.
