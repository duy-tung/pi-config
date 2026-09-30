---
name: to-spec
description: "Turn the conversation into a spec on the issue tracker, with a Verification section. No interview, synthesis only."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you (the `## Agent skills` block in `AGENTS.md` points at them). If not, tell the user to run `/skill:setup` before you publish.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better: the ideal number is one.

3. Sketch how the finished feature will be proven on the real artifact, not a proxy: which features of the repo's verify skill (`.agents/skills/verify-<app>/`) to drive, and which observable results show it works. If the repo has no verify skill, name the command or observation instead, and tell the user that `/skill:create-verify` builds one.

   Check with the user that these seams and this proof match their expectations.

4. Write the spec using the template below, then publish it to the project issue tracker with the `spec` label. The `spec` label marks a parent to slice with `/skill:to-tickets`, so AFK runners skip it instead of building the whole spec in one run. Create the label first if the tracker lacks it, without touching an existing one (on GitHub: `gh label list --search spec --json name`, then `gh label create spec --description "Parent spec: slice with /skill:to-tickets"` only when it is missing). When `docs/agents/triage-labels.md` exists, also apply its `ready-for-agent` label so triage leaves the spec alone; without that file, apply no triage label. A local markdown tracker has no labels: the spec goes to the spec path its doc names.

5. Tell the user the next step is `/skill:to-tickets` in this same conversation, without clearing or compacting first: a large spec truncates when it is fetched back.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature. For a refactor or a change to a module's interface, keep this list short and put the weight in Implementation Decisions and Testing Decisions.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- The seams agreed with the user, and which modules will be tested at each
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Verification

How the finished feature is proven on the real artifact, not a proxy. A passing test suite does not belong here. One line per user-visible outcome:

- <outcome>: drive <the verify-<app> feature> (or run <the command>) and observe <the result a user would see: screen state, response, output, stored data>.

The build ends with a verdict per line: VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass.

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
