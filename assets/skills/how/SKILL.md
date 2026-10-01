---
name: how
description: "Explain how code works or where something should live, tracing real code with file and symbol citations. Use for how-does-X-work questions and walkthroughs before changing a subsystem."
argument-hint: "<question about the code>"
---

# How

Answer "how does X work?" at the level of a senior engineer onboarding onto the subsystem: enough to build a working mental model, not so much that it reads like annotated source code. For the forces behind the code's shape, load the `why` skill.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple.** A single module, a small utility, or a narrow question such as "how does function X work". No subagents. Go to step 2.
- **Complex.** A subsystem spanning several files or services, a cross-cutting feature, or a full architectural overview. Go to step 3.

When in doubt, take the simple path.

## 2. Simple: explore and explain in one pass

Explore with the method in [EXPLORER.md](EXPLORER.md) yourself, starting from `symbol_search`, then write the answer with [EXPLAINER.md](EXPLAINER.md). Go to step 5.

## 3. Complex: explore in parallel

Split the question into 2 to 4 exploration angles, each a distinct slice of the subsystem (for example: the entry points and request flow, the data model and its storage, the seam with service Y). Before spawning, find each angle's entry points and call sites with `rg`. Spawn one `explorer` agent per angle, all in one response (parallel Agent calls). Each prompt is everything below the divider in [EXPLORER.md](EXPLORER.md), with the question and that agent's angle filled in.

Explorers do not see this conversation; they read AGENTS.md themselves. Put every pointer an explorer needs into its angle: paths, symbols, and the user's own words for the feature.

## 4. Synthesize

Write the explanation yourself with [EXPLAINER.md](EXPLAINER.md), from all the explorers' full reports (`get_subagent_result`). You own their output. An explorer reports only what its searches reached, so an absence in a report is not an absence in the code. Before you write a call chain, an ownership claim, or a gotcha, read the code that proves it. Resolve contradictions in the code, not by majority.

## 5. Present

Use the sections from EXPLAINER.md and drop any that do not apply: Overview, Key concepts, How it works, Where things live, Gotchas. Carry every open question the exploration left into the answer.
