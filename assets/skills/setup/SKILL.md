---
name: setup
description: "Configure this repo for tstack skills: tracker, domain docs, AGENTS.md pointers, coding standards, stack skills, stack hooks."
disable-model-invocation: true
---

# Setup

Write the per-repo files the tstack skills read. Explore first, ask one section at a time, show drafts, write only what the user approved.

In every step:

- Never overwrite an existing file without showing the diff and getting approval.
- Re-runs update in place: one `## Agent skills` block, one `.tstack/` ignore line, one `format` setting in `.pi-lens.json`, one copy per stack skill, no duplicate hook entries. A file that already matches its draft is reported as unchanged.

## 1. Explore

Read what exists. Ask nothing yet.

- **Remote**: `git remote -v`. Run `gh auth status` for a GitHub remote, `glab auth status` for a GitLab one.
- **Instruction files**: `AGENTS.md`, `CLAUDE.md`. Note whether `CLAUDE.md` holds only `@AGENTS.md`, whether an `## Agent skills` block exists, and which paths it points to.
- **Prior setup**: `docs/agents/`, `CODING_STANDARDS.md`, `.pi-lens.json`, `.agents/skills/verify-*/`, and stack skills in `.agents/skills/typescript/`, `python/` or `mobile/`.
- **Domain docs**: `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, `src/*/docs/adr/`. A `.scratch/` folder hints at a local tracker.
- **Stack**: `package.json` and its lockfile, `tsconfig.json`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`, `Podfile`, `*.xcodeproj`, `Package.swift`, `build.gradle` or `build.gradle.kts`, `pubspec.yaml`.
- **Monorepo signals**: `pnpm-workspace.yaml`, `workspaces` in `package.json`, `turbo.json`, `nx.json`, several `packages/*` with their own `src/`.
- **Checks**: the typecheck, lint, test and format commands (manifest scripts, `Makefile`, `justfile`, the CI workflow), formatter and linter configs, and existing gates (`.husky/`, `.pre-commit-config.yaml`, `lefthook.yml`, `.githooks/`).
- **Runnable surface**: a dev server or start script, a CLI entry point, an app target, a deployable service.
- **Ignore state**: `git check-ignore -q .tstack/probe` succeeds when `.tstack/` is already ignored.

Show the findings as a short found/missing list.

## 2. Ask, one section at a time

Lead each question with the recommendation so the user can accept it in a word. Use `ask_user_question`: one question per call, recommended option first. Skip a section that exploration already settled.

- **A. Issue tracker.** Recommend from the remote with [ISSUE-TRACKERS.md](ISSUE-TRACKERS.md).
- **B. Triage labels.** Ask whether to use them. Recommend yes for a shared repo that receives issues from others, no for a solo repo or a local tracker. On yes, ask whether to keep the default names (recommended: yes).
- **C. Domain docs.** Use single-context (one `CONTEXT.md` and `docs/adr/` at the root) without asking. Only with monorepo signals, offer multi-context (a root `CONTEXT-MAP.md` pointing to per-context `CONTEXT.md` files).
- **D. Instruction file.** `AGENTS.md` is canonical: Pi reads the first of `AGENTS.md` or `CLAUDE.md` in each directory, and `AGENTS.md` wins. For a team that also uses Claude Code, keep a `CLAUDE.md` containing only `@AGENTS.md`: Claude Code reads it, and Pi ignores it because `AGENTS.md` exists. Decide by this table. Ask only in the first row.

| Found | The block goes in |
|---|---|
| Neither file | A new `AGENTS.md`. Ask whether the team also uses Claude Code; on yes, add the one-line `CLAUDE.md`. |
| `AGENTS.md` only | `AGENTS.md` |
| `CLAUDE.md` only | `AGENTS.md`, which takes over `CLAUDE.md`'s content; `CLAUDE.md` becomes the one line `@AGENTS.md`. |
| Both, and `CLAUDE.md` holds only `@AGENTS.md` | `AGENTS.md` |
| Both, and `CLAUDE.md` has content of its own | `AGENTS.md`. Tell the user Pi does not load `CLAUDE.md` while `AGENTS.md` exists, and that `/skill:context-audit` can merge them. |

## 3. Draft, confirm, write

Draft every file below, show the drafts, let the user edit, then write.

- **`docs/agents/issue-tracker.md`**: the chosen template, or prose for another tracker, per ISSUE-TRACKERS.md.
- **`docs/agents/triage-labels.md`**: only when B is yes, from [triage-labels.md](templates/project/docs/agents/triage-labels.md). After writing it, create the labels per ISSUE-TRACKERS.md.
- **`docs/agents/domain.md`**: from [domain.md](templates/project/docs/agents/domain.md).
- **The `## Agent skills` block**, in the file D chose. Copy the format of the `## Agent skills` section in [AGENTS.md](templates/project/AGENTS.md) and fill each one-line summary. Keep `### Triage labels` only when B is yes, and `### Verification` only when `.agents/skills/verify-*/` exists (name each one). When a block already exists, rewrite only its tstack sub-blocks (Issue tracker, Triage labels, Domain docs, Verification, Coding standards), keep any other sub-block, and keep the paths it already uses: a block pointing at `internal/issue-tracker.md` keeps that path, and that file gets the update.
- **A new instruction file** (first row of D only): the whole [AGENTS.md](templates/project/AGENTS.md) template. Fill every `<placeholder>` from exploration or delete its section; a written file never contains a placeholder. Write the request-flow line from the entry points you read. Keep `## Navigation` only for hard-to-find, critical files. Seed `## When something breaks` from what exploration found (required services, env files, codegen steps) and ask the user for the symptom agents hit most; drop the section when there is none.
- **`CLAUDE.md`**, only where D calls for it: the single line `@AGENTS.md`.
- **`CODING_STANDARDS.md`**: only when absent, from [CODING_STANDARDS.md](templates/project/CODING_STANDARDS.md), with the language examples cut to the repo's languages. Leave an existing one untouched.
- **`.gitignore`**: append `.tstack/` unless it is already ignored.
- **Stack skills**, one per stack found: [typescript](../../stack-skills/typescript/SKILL.md) for `tsconfig.json` or TypeScript in `package.json`, [python](../../stack-skills/python/SKILL.md) for a Python manifest or lockfile, [mobile](../../stack-skills/mobile/SKILL.md) for an iOS, Android or Flutter app. They are not in the global skill list, so the agent sees one only in a repo that has it. Copy the whole directory to `.agents/skills/<name>/`. When the copy exists and differs, show the diff and replace it only on approval.

## 4. Stack hooks

Follow [STACK-HOOKS.md](STACK-HOOKS.md). Say its ladder line, then propose the three items in one message, each with what it adds and a recommendation, and ask which to add (one multi-select `ask_user_question`):

1. Editor-time formatting: `.pi-lens.json` with `{"format": {"enabled": true}}`, so pi-lens formats each file the agent edits with the repo's formatter (pi-config's global default is off). Recommended when the repo has a formatter config.
2. A pre-commit gate for the stack. Recommended when the repo has no pre-commit hook and no CI job running its checks.
3. Module-boundary enforcement. Opt-in.

Draft the approved items, show the diffs, write, then run each proof STACK-HOOKS.md gives.

## 5. Verification

When the repo has a runnable surface and no `.agents/skills/verify-*/`, tell the user to run `/skill:create-verify` next. Do not call it.

## 6. Report

List every file as created, updated, unchanged or skipped (with the reason), the labels created, the stack skills copied, the `.pi-lens.json` and hook entries added, and each proof with its result. Leave the changes uncommitted for the user to review. Tell the user they can edit `docs/agents/*.md` directly, and re-run `/skill:setup` to switch trackers or after upgrading pi-config. Name the next step: `/skill:create-verify` when step 5 applies, and `/skill:context-audit` when the instruction file runs past about 100 lines.
