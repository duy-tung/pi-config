---
name: diagnose
description: "Diagnose and fix bugs and perf regressions from a feedback loop that goes red first. Use when something is broken, throwing, flaky or slow, or for a profile, trace or heap snapshot."
---

# Diagnose

Find the cause of a bug from runtime evidence, then fix it at the root. Every shipped line traces to runtime evidence.

Read `CONTEXT.md` if it exists for the module names, and check ADRs in the area you touch.

## Pick the mode

- **Casual question** ("why does this throw?"): answer from the code, with one command if it helps. No loop.
- **Obvious one-line bug with a cheap red test** (you can see the cause, and an existing test file reaches it): write the failing test, watch it fail for the intended reason, fix, watch it pass, done. Report the red and green output. For the test rules, load the `tdd` skill.
- **Slow:** the full loop below, with [PERF.md](PERF.md) for the baseline, hypotheses and measurement.
- **Diagnosis only**, from a live process (leak, idle CPU spin, glitch) or a captured artifact (profile, trace, heap snapshot, spindump): [FORENSICS.md](FORENSICS.md). No fix unless asked.
- **Scoped bug you can hand off** (known area, known symptom): brief a `debugger` agent with the symptom, the repro, absolute paths, and this skill to load. Rerun its red and green evidence yourself before you accept the fix.
- **Anything else, or the light fix failed:** the full loop. Skip a phase only with a stated reason.

## Redact

Redact every secret you show: write `<REDACTED>` in its place. Build loops against environment variables so credentials stay out of what you show. Captured artifacts carry auth headers: quote only the lines that carry the signal. If the redacted output is not enough to diagnose, say so and ask the user.

## Phase 1: Build a feedback loop

**This is the skill.** With a tight pass/fail signal that goes red on this bug, you will find the cause: bisection, hypotheses and instrumentation all consume it. Without one, reading code will not save you. Spend disproportionate effort here. Be aggressive, be creative, refuse to give up.

**Reproduce on the surface the user saw it.** When the repo has a verify skill (`.agents/skills/verify-<app>/`), use its Launch and Drive steps. Reproduce it yourself. Ask the user to reproduce only with a specific reason your tools cannot reach the target, after driving as far as they go. If it will not fire, synthesize the trigger, tighten the conditions, or instrument until it does.

Ways to build the loop, in rough order:

1. A failing test at whatever seam reaches the bug (unit, integration, e2e).
2. A curl or HTTP script against a running dev server.
3. A CLI run on a fixture input, diffing stdout against a known-good snapshot.
4. The UI driven through the verify skill, or a headless browser script (Playwright) asserting on DOM, console or network.
5. A replayed capture: a saved request, payload or event log run through the code path in isolation.
6. A throwaway harness: the smallest subset of the system that reaches the bug in one call.
7. A property or fuzz loop: 1000 random inputs, watching for the failure mode.
8. A bisection harness: `git bisect run` over "build at state X, check".
9. A differential loop: the same input through the old and new version (or two configs), outputs diffed.
10. A human-in-the-loop script, last resort: copy [scripts/hitl-loop.template.sh](scripts/hitl-loop.template.sh), edit its steps, and ask the user to run it in their own terminal as `bash <copy> <result-path>` (your shell has no terminal for its prompts). When they say done, read the `KEY=VALUE` lines from that file.

**Tighten it.** Faster: cache setup, skip unrelated init, narrow the scope. Sharper: assert the specific symptom, not "didn't crash". Deterministic: pin time, seed randomness, isolate the filesystem, freeze the network.

**Non-deterministic bugs.** Aim for a higher reproduction rate, not a clean repro. Loop the trigger 100 times, parallelize, add stress, narrow timing windows, inject sleeps. A 50% flake is debuggable; 1% is not.

**No loop possible.** Stop and say so. List what you tried. Ask for access to an environment that reproduces it, a redacted captured artifact (HAR, log dump, core dump, screen recording with timestamps), or permission to add temporary production instrumentation. Do not hypothesize without a loop.

**Done when** you can name one command (a script path, a test invocation, a curl) that you have already run, with its invocation and redacted output shown, and that is:

- **Red-capable:** it drives the real bug path and asserts the user's exact symptom, so it goes red on this bug and green once fixed.
- **Deterministic:** the same verdict every run (for a flake, a pinned high reproduction rate).
- **Fast:** seconds, not minutes.
- **Agent-runnable:** it runs unattended, with a human only through the hitl script.

If you catch yourself reading code to build a theory before this command exists, stop. No red-capable command, no Phase 2.

## Phase 2: Reproduce and minimise

Run the loop and watch it go red. Confirm:

- It is the failure the user described, not a nearby one. Wrong bug, wrong fix.
- It reproduces across runs, or at a debuggable rate.
- The exact symptom is captured (error text, wrong output, timing) so later phases can check against it.
- On an app surface: you named the correct and the broken final states, and the broken state appeared twice through real interaction, with a reset between attempts. Read-only state inspection may confirm it; it must never inject or force the symptom.

**Minimise.** Cut inputs, callers, config, data and steps one at a time, rerunning after each cut. Done when every remaining element is load-bearing: removing any one of them turns the loop green.

## Phase 3: Hypothesise

Write **3 to 5 ranked hypotheses** before testing any. Each must be falsifiable:

> If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse.

A hypothesis without a prediction is a vibe: sharpen it or drop it. When the cause is not local, seed the list from the code and its history: load the `how` skill for the affected subsystem, and the `why` skill for regression history. To trace who reaches the failing code, search its call sites with `rg` and run the repo's typecheck on the files along the path. A bug that appears after a restart points at stale persistent state first: config files, caches, lock files, serialized state.

Show the ranked list to the user before testing; they often re-rank it at once. Do not wait if they are away.

## Phase 4: Instrument and narrow

Binary-search the cause. Each pass, take the split that rules out the most remaining hypotheses, get runtime evidence, eliminate. Every probe maps to a prediction from Phase 3. Change one variable at a time.

- A debugger or REPL beats logs. Otherwise, targeted logs at the boundaries that separate hypotheses. Never "log everything and grep".
- Tag every debug line with one session tag, `[DEBUG-xxxx]` with four random hex characters. Cleanup is then one grep.
- When program state is unclear, instrument and read it as the code runs. Do not guess.

Done when one hypothesis survives with runtime evidence for its mechanism.

## Phase 5: Fix with a regression test

**Fix the root cause.** Ask why until you reach the code that produced the wrong state, not the code that noticed it.

- No guards that silence the symptom: a null check that stops the crash, a retry that hides a broken contract, a cast that silences a type error, a catch that swallows. If a workaround needs a paragraph-long comment to justify it, the code is wrong.
- Grep for every instance of the pattern. Fix each one in scope and list the rest.
- The smallest change the evidence justifies ships. Belt-and-suspenders that might help is a hypothesis, not a fix. When evidence refutes a hypothesis, revert what it motivated.
- A fix that changes an interface, a data format or a default: when the user is present, show the mechanism and the plan first. Otherwise proceed.
- A fix that crosses a module's interface: sketch the interface first (load the `codebase-design` skill).

**Regression test at a correct seam.** A correct seam exercises the real bug pattern as it occurs at the call site. A seam too shallow to replay the chain that triggered the bug (a single-caller test when the bug needs several callers) gives false confidence. **If no correct seam exists, that itself is the finding:** note it, prove the fix through the Phase 1 loop instead, and tell the user to run `/skill:improve-architecture`.

With a correct seam, follow the test rules in the `tdd` skill (load it if it is not loaded yet):

1. Turn the minimised repro into a failing test at that seam and watch it fail.
2. When the work gets committed, commit this red test before the fix (with the `tdd` skill's expected-failure marker if hooks reject a red commit).
3. Apply the fix and watch the test pass. The repo's typecheck or lint on the touched files is a faster first signal, not proof.
4. Rerun the Phase 1 loop on the original, un-minimised scenario.

**Verify on the surface the user saw the bug:** load the `prove` skill. Unit tests show branch behavior, not bug absence. Inconclusive or wrong-surface is not a pass.

### Two failed fixes: attack the premise

When two fixes that share one premise have failed the same check, stop fixing. Call `ask_advisor` before a third attempt when it is listed and has calls left: its answer is advice, not proof. A subagent, which has no `ask_advisor`, reports the premise and both failed fixes to its parent instead.

1. Write the premise down: the one sentence every failed fix assumed.
2. Take a census before the next fix, as a rerunnable script. Count the symptom per actor (worker, thread, request type, tenant, file). It shows who holds the imbalance, not how large it is.
3. Read the skew. If the same few actors hold most of it on every run, something assigns them that role. Find what assigns it: that is the next "why".
4. Remove the asymmetry instead of compensating for it: rotate the role, randomize the assignment, or move the role. A return path, a shared pool or a periodic rebalance leaves the assignment in place.

If the census is even across actors, the premise is not the cause. Look elsewhere, and keep the census as evidence.

## Phase 6: Clean up

- [ ] The Phase 1 loop no longer reproduces the bug.
- [ ] The regression test passes, or the missing seam is documented.
- [ ] `grep -rn "\[DEBUG-"` finds nothing you added.
- [ ] Throwaway harnesses are deleted or moved to a clearly marked debug location.
- [ ] The commit or PR message names the hypothesis that was right.

## Reply

What was broken, the root cause and the evidence that confirmed it, the fix, and how you verified it. Paste the failing-then-passing repro output verbatim, redacted.
