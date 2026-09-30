---
name: work
description: "One entry point: classify any task, pick its flow or playbook, run it in visible steps. `/skill:work ?` says what fits."
disable-model-invocation: true
argument-hint: "<task> | ?"
---

# Work

Route the task, then run the route with every step visible in the task list.

## 1. Route

Pick the first row that fits and say which one in a single line.

| The task | Route |
|---|---|
| `?`, "which skill", "what next", "where am I in the flow" | Answer from the flow map below: name the next command and why. Stop. |
| Resume or take over earlier work | [playbooks/pickup.md](playbooks/pickup.md) |
| An explicit pause ("stop for now"). Never on "keep going" | [playbooks/pause.md](playbooks/pause.md) |
| A read-only question: how does X work, why is Y like this, are we sure | [playbooks/investigation.md](playbooks/investigation.md) |
| Something is broken or behaves wrong | [playbooks/bug.md](playbooks/bug.md) |
| A measured slowness, fixed once | [playbooks/perf.md](playbooks/perf.md) |
| Improve one metric toward a target over many attempts | [playbooks/hillclimb.md](playbooks/hillclimb.md) |
| Change the structure, keep the behavior | [playbooks/refactor.md](playbooks/refactor.md) |
| One mechanical change across many call sites, or a migration | [playbooks/wide-change.md](playbooks/wide-change.md) |
| A design question that needs something runnable to settle | Load the `prototype` skill. |
| New or changed behavior | [playbooks/feature.md](playbooks/feature.md) |
| The user will be away ("going to bed", "run until done", "trust it when I'm back") | Tell the user to run `/skill:afk` with the task. Stop. |
| Nothing above fits | [playbooks/figure-it-out.md](playbooks/figure-it-out.md) |

## 2. Run the playbook visibly

1. Read the playbook file.
2. Before any task-specific todo, add each playbook step with the `todo` tool, wording copied verbatim. When a goal is active, its task list is the progress source: do not duplicate it in `todo`.
3. A step you decide not to do stays in the list as `skip: <reason>`. Never drop a step silently.
4. Work the steps in order. Each step ends in a check before the next begins.
5. Finish with the playbook's Reply section.

## 3. Rules on every route

- **Data shape first.** Before writing logic, name the data shape and the structure the code hangs on (state machine, registry, typed model).
- **Observe, don't ask.** A "which approach" fork whose answer you could observe by running something is yours: settle it with the `prototype` skill or a quick experiment and report the result. Ask the user only for product or preference calls no experiment can settle.
- **Prove before done.** Load the `prove` skill before declaring any change done. Report VERIFIED, NOT VERIFIED or INCONCLUSIVE with evidence.
- **Principles as vocabulary.** For a design or trade-off decision, load the `principles` skill and name the principle that changed each decision.
- **Own your subagents.** Brief them with pointers, read their diffs yourself, write your own summary.
- **Phase boundaries.** When a phase ends, choose continue, clear, handoff, subagent or compact with [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md). Mid-phase, continue or split the rest into subagents.
- **Candor.** "Not worth doing" is an acceptable answer. Say it with the reason.

## Flow map

Answer `?` from this map. Name commands exactly as written.

**Main flow: idea to ship.**

1. `/skill:grill-with-docs` in a repo (`/skill:grill-me` outside one) until you and the agent share one design. Questions that need running code detour through the `prototype` skill.
2. Fits in one smart zone (about 150k tokens)? Build it now with `/skill:implement`. Bigger? `/skill:to-spec`, then `/skill:to-tickets`, then `/skill:implement <ticket>` once per ticket, clearing context between tickets. Keep grilling, spec and tickets in one unbroken window.
3. `/skill:ship` opens the PR and babysits it.
4. `/skill:reflect` after a long or bumpy task: turn each repeated correction into a type, lint rule, hook or standard.

**Unattended.** `/skill:afk` runs tickets or a goal under a written contract, with an independent verifier, a decision log and a morning report. The run is a Pi goal: watch it with `/goal-status`.

**On-ramps.** Something broken: `/skill:work <symptom>` (bug playbook). A huge, foggy effort: `/skill:wayfinder`. Incoming issues you did not write: `/skill:triage`. A spare moment: `/skill:improve-architecture`.

**Setup and upkeep.** `/skill:setup` once per repo. `/skill:create-verify` once per app, `/skill:maintain-verify` when the app drifts from its feature map. `/context-budget` shows the always-on context by part; `/skill:context-audit` trims it when sessions feel slow, noisy or expensive.

**Anytime.** `/skill:handoff` moves work to another session, harness or person. `/skill:wait-what` when a message did not land. `/rewind` discards a failed approach, code and conversation both.

**Disciplines the agent loads on its own** (you can name them too): grilling, domain-modeling, codebase-design, principles, tdd, diagnose, prove, interrogate, how, why, prototype, research, decision-log, unslop, writing-for-agents, resolving-merge-conflicts, wizard, typescript, python, mobile.
