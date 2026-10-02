# Blast radius

Find what a change breaks somewhere else, before it ships. Listing the callers is not the job: grep does that in a second. The job is the breakage grep will not show you.

A blast-radius writeup that sounds right is worthless: it reads as convincing whether or not it is true. Find the one or two facts the change's safety depends on, and prove them by running code.

## How sure are you

Take each fact as far down this ladder as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line: a real `file:line`, or the library's own source.
3. You showed the bad case cannot happen: you walked the failure step by step and it does not reach.
4. You ran it: a script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

Step 4 is usually one small script that imports the same library the app ships and calls the exact function you worry about.

## Steps

1. **Read the change:** the diff, the symbols it adds, changes and deletes, and what it now does differently, including what the diff does not spell out. For the PR and commit history, load the `why` skill.
2. **Find the one fact it is safe because of.** Most risky-looking changes are safe because of a single fact, like "this call only drops cache entries that are already dead". If it holds, most risks clear at once. Spend your time here, not on a long list of maybes.
3. **Look where grep stops:**
   - The source of the library you call, its pinned version, and any local patch.
   - Timing: microtasks, unmount and teardown, lifecycle order, async ordering.
   - What a symbol search misses: API JSON, database columns, wire formats, serialized caches, another language reading the same bytes.
   - Feature flags, and code three hops downstream.
   - Clients and data from the previous version: installed mobile builds, open browser tabs, persisted state.
4. **Be honest about each risk:** a real chance of happening and a real cost if it does. Keep the risks you confirmed apart from the ones you checked and cleared. Cite a real `file:line`. A search that finds nothing is still an answer. Never make up a caller or an API.
5. **Prove the one fact:** write a script or test that runs the real code, run it, and paste what happened.
6. **Wide change:** ask the same question of two `explorer` agents in one response (parallel Agent calls), collect both with `get_subagent_result`, and merge their answers. Different reviewers catch different real bugs.

## Reply

- **What it does.** What changed, including the part that is not obvious.
- **The one fact it is safe because of.** State it, the ladder step it reached, and the proof. If you could not prove it, write "unproven".
- **Risks.** For each: how it breaks, `file:line`, likelihood, severity, and how to check. Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script you wrote.

Cite real code, and strip anything private before the writeup goes anywhere public. For prose a human will read, such as a PR body, load the `unslop` skill.
