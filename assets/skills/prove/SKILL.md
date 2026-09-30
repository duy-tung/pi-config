---
name: prove
description: "Prove a change on the real artifact, not a proxy, and return VERIFIED, NOT VERIFIED or INCONCLUSIVE with evidence. Use before declaring work done, for prove-it requests, and for what-could-this-break."
argument-hint: "[what changed or what to prove]"
---

# Prove

Check the real artifact. A type check and green CI are not proof. Proof is an observation of the changed behavior on the surface a user or caller touches, with evidence someone else can inspect or rerun.

## Verdicts

- **VERIFIED.** The changed behavior was observed on the real surface for every touched entry point, with evidence at a named path.
- **NOT VERIFIED.** The check ran and the behavior is wrong or missing. Report the negative; never hide it.
- **INCONCLUSIVE.** The check could not run, ran on the wrong surface, or the evidence does not show the discriminating state. Inconclusive or wrong-surface is not a pass.

Label every claim in the reply measured, inferred or guess. Never hand the human a check you could run.

## Writer is not checker

For changes you authored in this session, spawn the `verifier` agent (foreground; it returns the verdict) and report its verdict. Its brief:

- What changed: the commits or the diff command.
- The features and entry points it touches, and the expected observable result for each, before and after.
- The verify skill's absolute path, or the absolute path of `../create-verify/CONTROL-ADAPTERS.md` when the repo has none (next section).
- The evidence directory.
- "Do not spawn agents or run user-invoked skills. Verify directly."

Read the evidence files yourself before you report: you own the verdict. With no Agent tool (you are a subagent), verify directly and label the report "self-verified" so the main thread can spawn an independent verifier. When someone else wrote the change, verify directly.

## Find the verify skill

Look for `.agents/skills/verify-<app>/SKILL.md` in the repo. With several, pick the one for the surface the change touches. Follow its Launch, Doctor, Drive, Evidence and Cleanup, and read the feature file for each touched feature: drive every entry point the map lists, not one convenient path.

- **No verify skill:** drive the surface directly with the recipes in [CONTROL-ADAPTERS.md](../create-verify/CONTROL-ADAPTERS.md), and tell the user to run `/skill:create-verify` so the next proof is cheaper.
- **A documented step no longer matches the app:** drive as far as the real app allows, record the drift, and tell the user to run `/skill:maintain-verify`. Never edit product code to match the docs.

## Match the check to the change

Before you drive anything, write down the expected observable result for each touched entry point. An observation with no stated expectation cannot fail.

| Change | Proof |
|---|---|
| CLI | Run the real command on real input. Keep the command, stdout, stderr and exit code. |
| UI (web, desktop, mobile) | Walk the flow through the real UI. Keep an accessibility snapshot or view hierarchy, plus a screenshot that shows the app's identity. |
| API or service | Call the running endpoint. Keep the request, status and body, then read back the side effect. |
| Parser or transform | Replay saved real input and diff the output against a known-good snapshot. |
| Performance | Compare profiles or timings before and after: same machine, same data, median of N. |
| Storage or migration | Write through the real path, then read the value back through a second, read-only view. |
| Library | Import the built package the way a consumer does, from a scratch script, and call the changed function. |
| Config or flag | Start the app with the setting each way and observe the difference. |

## Evidence rules

- **Exercise the real user path.** No internal setters, test-only endpoints or injected state. Mocks only where a production boundary already isolates the external system.
- **Capture the action and the resulting state**, not only the final screen. Check side effects (files written, rows inserted, messages sent) alongside what is visible.
- **Bug fixes meet the repro standard.** Name the correct and the broken final states. Before the fix, the broken state appears twice through real interaction, with a reset between attempts. After the fix, the same path twice shows the correct state. Cross-check one read-only state value both times. State inspection may confirm an observation; it must never inject or force the symptom. A compile, a unit test, a review or a plausible diff is not after-evidence.
- **Someone else's fix:** the baseline twice (symptom present) against the patched build twice (symptom gone), with the same environment and data. If the baseline does not reproduce twice, there is no baseline: do not claim the fix works, and say which half could not be measured.
- **Translated environment.** When the exact environment is unavailable (another browser, a simulator instead of a device), label the result "translated evidence". It is not an exact repro when the missing environment is part of the defect.
- **Suspect the observation method before the system** when verification fails or passes too easily: a stale build, the wrong port, a cached page, another instance.
- **Script the check** when you can, and keep the script with its output.
- **Evidence lives at a named path that survives cleanup:** the verify skill's evidence directory, else `.tstack/<slug>/evidence/` when the run has one, else `/tmp/tstack-prove-<slug>/`. Redact secrets.
- **Stop what you started**, by PID or session. Never kill by process name, and never kill what you did not start.

## What could this break

When the change is risky, the user asks "what could this break" or "blast radius", or you do not trust a small diff, read [BLAST-RADIUS.md](BLAST-RADIUS.md) and run it before or alongside the proof.

## Reply

- The verdict, and who verified: the `verifier` agent, or self-verified.
- Per entry point: what was done, what was observed, the evidence path.
- What was not covered, and why.
