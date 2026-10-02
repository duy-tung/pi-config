# Skill mechanics

The skill-specific branch of [writing-for-agents](SKILL.md): what changes when the document is a skill on Pi (frontmatter, the invocation choice, how skills call each other, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Pi lists every model-invoked skill in the system prompt: its name, its description, and the absolute location of its `SKILL.md`. The agent loads a skill by reading that file with the `read` tool. A human runs any skill with `/skill:<name> <args>`: Pi inlines the body, notes that references are relative to the skill folder, and appends the args as the user's request.

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type `/skill:<name>`: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can load it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill sets `disable-model-invocation: true`, which hides it from the list: only the human typing `/skill:<name>` can run it, and no other skill can. Zero context load, but it spends cognitive load: you are the index that must remember it exists. Mechanics: the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load. The test is "could the model usefully reach for this autonomously?"; reuse is the reason to extract a skill, not the test.

The model never sees a user-invoked skill, so an agent asked about one may report it as not installed. Routers and wrappers name user-invoked skills for the human; nothing else can reach them.

Shared reference that two user-invoked skills both need can live in neither: with no descriptions, neither can fire the other. Push it to a plain file outside the skill system, or into a model-invoked skill both can load.

## Frontmatter

- `name`: lowercase `a-z0-9-` (no leading, trailing or double hyphen), at most 64 characters, equal to the folder name. Names have no namespace and never contain `:`. On a name collision Pi keeps the first skill it discovers and warns.
- `description`: required; a skill without one does not load. For a user-invoked skill, a one-line human summary under 120 characters. For a model-invoked skill, what it does and when to use it, trigger cases front-loaded, under 300 characters (Pi's hard limit is 1024). Quote a description that contains `: `, or YAML reads it as a mapping.
- `disable-model-invocation: true` on user-invoked skills only.
- Optional: `argument-hint`, a label for the human. Pi ignores keys it does not know; leave the rest out.

## Where skills live

- pi-config installs its skills and manages them; the installer keeps your edits on reinstall. Run `/reload` after editing a skill in a running session.
- A project's own skills go in `.agents/skills/<name>/`, which Pi loads once the user trusts the project.
- Scripts are installed without the executable bit: run them with `bash <skill folder>/scripts/<file>`, the folder resolved from the skill's `<location>`.

## Calling other skills

- **The call rule.** A user-invoked skill may load model-invoked skills. It never loads another user-invoked skill: it tells the user to run it instead (tell the user to run `/skill:setup`). A model-invoked skill may load other model-invoked skills. Pi enforces the rule: a user-invoked skill is not in the list the agent reads.
- **Name the skill.** An operative dependency is an explicit instruction: "Load the `grilling` skill", or "Load the `grilling` and `domain-modeling` skills" for two. The agent finds each in the skill list and reads its `SKILL.md`. A bare `/skill:<name>` in prose is a label for the human, not a load.
- **Reach material by loading its skill.** Links point at sibling files in the skill's own folder (a relative link to `RUBRIC.md`); a relative path is relative to the file it appears in. Link into another skill's folder only for a file no load reaches: a supporting file (`../ship/BLAST-RADIUS.md`), or a user-invoked skill's file another skill must read. When a subagent needs one of the skill's files, put its absolute path in the brief, resolved from the skill's `<location>`.
- **Check the load.** Naming a skill does not reliably load it. A wrapper that depends on another skill's behaviour names the tell that it loaded ("if your questions come without recommended answers, grilling did not load: read its SKILL.md again").
- **Reading a doc is not loading a skill.** Merely reading `CONTEXT.md` for vocabulary is a one-line prose pointer, not the domain-modeling skill.

## Subagents

- Spawn a role with the `Agent` tool: `researcher`, `worker`, `debugger` or `reviewer`; the global AGENTS.md says what each is for. The role pins its model and thinking: never pass `model` or `thinking`.
- A subagent does not see the conversation. Brief with pointers (absolute paths, SHAs, commands), not pasted dumps. Each brief stands alone: goal, scope, context pointers, acceptance, verify, forbidden, report format.
- Several `Agent` calls in one response run in parallel (at most 4 in the background, 2 in the foreground; the rest queue). Collect background results (`researcher`, `reviewer`) with `get_subagent_result` (`wait: true`).
- The main thread is the only spawner: subagents have no Agent tool. End every brief with: "Do not spawn agents or run user-invoked skills. Do the work directly."
- You own each subagent's output: read its diff or file yourself, never pass its summary through.

## Per-repo config

Skills find the repo's tracker, labels, and domain docs through the `## Agent skills` block in `AGENTS.md`. A skill that cannot work without that config (it publishes to a tracker or applies labels) says so in one line: tell the user to run `/skill:setup`. Every other skill proceeds silently when a doc is missing, and names "the project's domain glossary" and "ADRs in the area" in plain prose.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills are not in the skill list, so nothing but the human can reach them. Adding, renaming, or removing a user-reachable skill means updating the router, or it becomes a router that lies.
