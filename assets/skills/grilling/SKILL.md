---
name: grilling
description: "Interview the user in rounds until you share one understanding of a plan, with a recommended answer per question. Use for any grill request or before building something unclear."
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round. If the user's own instructions say to ask one question at a time, keep the same frontier and ask it one question per message.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, docs, etc.), dispatch a `researcher` agent for a fact in the code, docs, the web or git history (it runs in the background); don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the agent to report; ask the rest of the frontier now.

Classify each fork before asking. If the answer is a fact you could observe by running something (behavior, timing, layout, output, perf), it is not the human's to answer: settle it by observation (load the `prototype` skill, or run a quick experiment) and report the result as a fact. Reserve questions for product or preference calls no experiment can settle.

The _decisions_ are the user's: put each to them and wait for their answer, even when a surrounding task (a ticket to resolve, a build to start) pulls you to keep moving.

If the user says they are going to be away, apply your recommended answer to each open decision, list each one in your reply, and flag each default with the one word that reverses it. Their going away stands in for confirming those defaults only: irreversible actions still wait for them.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
