# Context audit checklist

## Reading the numbers

- `/context-budget` estimates tokens as characters divided by 4. Use it to compare parts, and before with after; it is not a bill.
- Every part it lists loads on every request. Skill bodies, user-invoked skills (`disable-model-invocation: true`) cost nothing until used, and an MCP server is lazy and sits behind the one `mcp` proxy tool unless it sets `directTools`.
- Pricing is arithmetic, not a probe: a change saves the rows it removes. The re-measure in step 4 confirms it.

## Levers

Pi has no auto-memory or connectors setting. The levers are below; pi-config's installer keeps user edits to its files on reinstall.

| Change | Removes | You lose |
|---|---|---|
| Disable a skill: `pi config` (it lists skills, extensions and prompt templates; `--local` for this project), or a `!pattern` or `-path` exclusion in the `skills` array of `~/.pi/agent/settings.json` or `.pi/settings.json` | its line in the skill list | that skill, `/skill:<name>` included |
| `disable-model-invocation: true` in a skill's frontmatter | its line in the skill list | the model and other skills loading it; `/skill:<name>` still works |
| Disable an extension the same way (`extensions` array) | its tool definitions and prompt text | every tool and command it adds, and the skills that call them. Never `pi-auto-mode`: it is the permission gate. |
| `"directTools": false` on an MCP server in its config file (`mcp-adapter.json` or `.mcp.json`), or a list of only the tools you call | each other direct tool definition | direct calls: those tools stay reachable through `mcp({search})` and `mcp({tool})` |
| Remove an MCP server from its config file, or set `"disabled": true` | its direct tools | that server |
| Shorten a role's `description` in `~/.pi/agent/agents/<role>.md` | its text in the Agent tool definition | nothing, while the description still says when to use the role |
| Agent tool description `compact` (`/agents` → Settings) | about three quarters of the Agent tool definition | its usage notes; the parameter descriptions stay |

## Line tests

Tests 1 to 3 decide whether a line lives at all; test 4 decides where it lives.

1. **Single source of truth.** A fact lives in one place, and executable sources win. A line that restates the environment (manifest scripts, config files, directory layout, `--help` output) fails. When two steering files say the same thing, keep the copy in the narrowest file that still loads in every session that needs it.
2. **Sediment.** Once true, not now. Check every path, command, name and claim against the repo today (`ls`, `grep`, `--help`). A stale line fails; fix it instead only when the rule behind it still holds.
3. **No-op.** The line must change behavior versus the default. "Write clean code", "be thorough" and "follow best practices" fail. So does a leading word too weak to beat the default.
4. **Push or point.** Point by default. A line stays inline only when it changes behavior in every session, or its trigger is unpredictable (a "When something breaks" symptom and cause table).

## Verdicts

Take the first row that matches.

| The line is | Verdict |
|---|---|
| failing test 1, 2 or 3 | delete |
| a mechanical rule a tool could check (banned import or call, file location, naming) | encode as lint/hook |
| a judgment call a reviewer applies to a diff | move to CODING_STANDARDS.md |
| a procedure with a predictable trigger ("when releasing", "when adding a migration") | move to skill |
| reference that only some sessions need | move behind pointer |
| a navigation pointer to a hard-to-find, critical file that exists today | keep |
| any other navigation pointer | delete |
| passing test 4 | keep |

Stale pointers are worse than none: a pointer whose target is gone gets deleted, not kept "for later".

## Also flag

- `CLAUDE.md` beside `AGENTS.md` with content of its own: Pi reads only `AGENTS.md` in that directory, so the `CLAUDE.md` lines are dead for Pi and drift. Propose one canonical file: `AGENTS.md`, with `CLAUDE.md` reduced to `@AGENTS.md` for a team that also uses Claude Code.
- An `@path` line is not an import on Pi: Pi reads it as plain text. Replace it with a pointer that names the file and when to read it, except the one `@AGENTS.md` line of such a `CLAUDE.md`.
- An `AGENTS.md` in a parent directory loads in every session below it, and Pi has no setting to exclude it. When it does not apply to this repo, propose moving or narrowing it.
