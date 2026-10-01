# P13. Guard the context window

**Rule.** The context window is finite and does not renew within a session. Route bulk work to subagents and keep summaries, not raw payloads, in the main thread.

**Apply.**

- Send verbose output, screenshots, traces, large documents and wide searches to subagents (`explorer` agents for bulk code reading, `researcher` agents for docs, logs and the web). The main thread gets the reduced finding.
- Brief with file pointers, not pasted dumps. Each brief stands alone: goal, scope, pointers, acceptance, how to verify, what is forbidden, report format.
- You own every subagent's output. Read the diff or artifact yourself; never pass its summary through.
- Keep a template used on every invocation inline in the skill that uses it. Push the rest behind pointers.
- Size phases and cap scope: files per phase, turn budgets.
- Quality holds for roughly the first 150k tokens; the smart-zone reminder (sent when context turns yellow near that edge or red past it) is the signal. Decide what to do with the context only at a phase boundary: continue, clear, hand off, delegate to a subagent, or compact. `/skill:work` holds the decision tree.

**Test.** Does the main thread hold anything a subagent could have reduced to a paragraph?

> Every token should be worth its cost.
