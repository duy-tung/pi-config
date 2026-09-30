---
name: context-audit
description: "Measure always-on context (AGENTS.md, skills, tools, MCP, settings) and prune it with approval."
disable-model-invocation: true
---

# Context audit

Measure always-on context, propose cuts with their saving and what they cost the user, apply only what the user approves, then measure again. A line survives only when it changes behavior in every session, or its trigger is unpredictable.

Read [CHECKLIST.md](CHECKLIST.md) before step 2. It holds the levers, the line tests and the verdict routing.

## 1. Measure

- Ask the user to run `/context-budget`, or use its report if it is already in the conversation: the report lands in the conversation as a message you can read, without starting a turn. The pi-config command prints the always-on parts by size: the base prompt, each AGENTS.md file, the skill list by folder, and the active tool definitions by extension, with a total.
- Note the baseline total, each part and the five largest items.

## 2. Settings

Read `~/.pi/agent/settings.json` (its `packages`, `extensions` and `skills` entries), the project's `.pi/settings.json` when present, the MCP configs (`~/.pi/agent/mcp-adapter.json`, `.mcp.json`, `.pi/mcp-adapter.json`, `~/.config/mcp/mcp.json`) and the role files in `~/.pi/agent/agents/`. Build the candidates from CHECKLIST.md "Levers", skipping anything already off. Price each one by the `/context-budget` rows it removes; an item the output does not list on its own (one skill in a folder, one tool) costs its characters divided by 4, the command's own estimate. Price the chosen set together before applying it.

Show one table (Change, Saves, You lose) and ask which rows to apply, as one multi-select `ask_user_question`. Apply only the rows the user picked, by editing the file (the user may run `pi config` instead: it is interactive). Copy the file to `<file>.bak-<timestamp>` first, merge the entries (append exclusions to the `skills` or `extensions` array, never replace it), then validate it as JSON with `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' <file>`.

## 3. Steering files

Read in full every context file `/context-budget` lists: the global `~/.pi/agent/AGENTS.md` (installer-managed by pi-config, which preserves user edits), the project's `AGENTS.md` and any in parent directories. Also read `APPEND_SYSTEM.md` in `~/.pi/agent/` or `.pi/` when present, and a `CLAUDE.md` that sits beside an `AGENTS.md` (CHECKLIST.md "Also flag").

Run every line through CHECKLIST.md "Line tests", route it with "Verdicts", and check "Also flag". Output one table:

| Where | Line or section | Verdict | Reason |
|---|---|---|---|

`Where` is `file:line`. Verdict is one of: keep, delete, move behind pointer, move to skill, move to CODING_STANDARDS.md, encode as lint/hook. Reason names the deciding test in a few words. Merge consecutive lines with the same verdict into one row. Ask which rows to apply; the rest stay as they are.

## 4. Apply and re-measure

Apply the approved rows only:

- **delete**: remove the line.
- **move behind pointer**: move the text into a doc beside the code it describes, and leave one line naming the doc and when to read it.
- **move to skill**: load the `writing-for-agents` skill, write `.agents/skills/<name>/SKILL.md` (`~/.agents/skills/<name>/SKILL.md` for a line from the global AGENTS.md) with the trigger in its description, then remove the line.
- **move to CODING_STANDARDS.md**: append the rule, creating the file from [the template](../setup/templates/project/CODING_STANDARDS.md) when absent.
- **encode as lint/hook**: build it when it is a config change (a banned import, a restricted pattern, a hook). Otherwise list it as a follow-up and leave the line until the check exists.

Check that every pointer you left resolves. Re-measure: ask the user to run `/reload`, then `/context-budget` again, and compare with the baseline in one table (Part, Before, After, Change).

Report that table, then the rows applied, the rows declined and the follow-ups.
