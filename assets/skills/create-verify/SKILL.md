---
name: create-verify
description: "Generate a project verify skill that drives your app like a user and captures proof (web, CLI, API, mobile)."
disable-model-invocation: true
argument-hint: "[app or surface]"
---

# Create a verify skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill at `.agents/skills/verify-<app>/`, tailored to the repo: the Agent Skills location, which Pi loads once the project is trusted and which the `prove` skill and the `verifier` agent also read by path to drive the app. You write the generator's output for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app.

## 1. Interview the repo, not the user

Answer these from the codebase. Ask the user (`ask_user_question`) only what you cannot observe.

- **Existing skill.** If `.agents/skills/verify-*/` already covers this app, stop and tell the user to run `/skill:maintain-verify` instead.
- **Surface.** What does a user actually touch? A web UI, a CLI or TUI, a desktop app, an HTTP API, a mobile app, a library? A repo can have several: pick the primary one and note the rest.
- **Run.** How does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive.** How can an agent interact with it programmatically? Existing harnesses first: Playwright or Cypress specs, XCUITest, Espresso or Maestro flows, `integration_test`, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a recipe from [CONTROL-ADAPTERS.md](CONTROL-ADAPTERS.md).
- **Observe.** What evidence can be captured? Screenshots, accessibility snapshots, view hierarchies, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate.** Can two instances run side by side (ports, data dirs, profiles, simulators)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating: a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

Evidence goes to `.tstack/verify-<app>/<run-id>/` unless the repo has its own convention. Run `git check-ignore -q .tstack/`. If it fails, tell the user to run `/skill:setup` (it gitignores `.tstack/`), or name an evidence directory outside the repo.

The interview is done when every bullet has an answer backed by a file path or a command you ran, or a question you asked the user.

## 2. Generate the skill

Write `.agents/skills/verify-<app>/SKILL.md` with YAML frontmatter. Without frontmatter the skill never registers. Leave `disable-model-invocation` out so the `prove` skill and the `verifier` agent can reach it. The description names the app, the surface, and when to reach for it:

```yaml
---
name: verify-notes
description: Drive the Notes web app and CLI like a user and capture proof. Use to verify a Notes change, reproduce a Notes bug, or check a feature on the running app before calling it done.
---
```

Then write these six sections, each grounded in what the interview actually found. No placeholders left: every command, selector, port, and path is real for this repo.

- **Launch.** The exact command that starts the app for verification, and how to tell it's ready (a log line, a port answering, a prompt). Include teardown. One instance per run, with its own port, data dir, profile, tmux session, simulator, or emulator. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session. Bash calls do not share shell variables, so the run writes its IDs, ports, and paths to a run file that every later call sources. [CONTROL-ADAPTERS.md](CONTROL-ADAPTERS.md) has the scaffold.
- **Doctor.** One read-only check that answers "is this instance worth driving?": process up, right version or build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive.** The harness recipe with real selectors and commands from this repo, not examples. Prefer stable handles (ARIA roles and accessible names, `data-testid`, accessibility identifiers, prompt strings, route paths) over coordinates and tab order. Never use generated CSS classes, hashed class names, or child indexes. Use coordinates only after a fresh screenshot.
- **Evidence.** What to capture for a proof, and where it goes. Write these proof standards into the generated skill:
  - Exercise the real user path, not internal setters or test-only endpoints.
  - Capture the action and the resulting state, not just the final screen.
  - Verify side effects (files written, rows inserted, messages sent) alongside what's visible, through a read-only second view of the stored value.
  - Use mocks only where a production boundary already isolates the external system.
  - When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
  - **Bugs reproduce twice.** Before driving, name the correct final state and the broken final state. The exact discriminating symptom must appear twice through the real surface, with a reset between attempts so the second attempt is independent. An expected dialog, a loading state, or a setup step is not the bug. A read-only state cross-check may confirm what the surface shows; it never injects or forces the symptom. Without two appearances, the outcome is "could not reproduce", or "blocked" with the missing prerequisite named.
  - **Fixes prove the same way.** The same path twice on the patched build shows the correct final state, with the same cross-check. A compile, a unit test, a code review, or a plausible diff is not after-evidence.
  - Label a run in a substitute environment (another browser, another OS, a simulator for a device bug) "translated evidence". It is never an exact repro when the missing environment is part of the defect.
  - Look at every screenshot you cite: it must visibly show the state you claim, with enough of the app to identify it.
  - Keep secrets out of evidence. Redact tokens, cookies, and auth headers.
  - Report VERIFIED, NOT VERIFIED, or INCONCLUSIVE with the evidence paths. Inconclusive is not a pass.
- **Cleanup.** How to tear down what the run created. Never kill by process name; kill what you started (recorded PIDs and process groups, tmux sessions, simulator UDIDs, emulator serials). Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names. Cleanup runs after a failed drive too.
- **Helpers.** Any script the skill ships lives in `.agents/skills/verify-<app>/scripts/`, is executable, and has its invocation shown in the skill body with a repo-relative path. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create `.agents/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify. Aim for the top 3 to 5 to start, taken from routes, commands, screens, menus, or docs. Follow the shape in [feature-map-example/](feature-map-example/README.md): a README index and one file per feature.

Each feature file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. Every feature file has exactly four H2s, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The map is the repo's maintained verification source: a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs can cover the rest), capture evidence, clean up.

Run it cold. Spawn one fresh `verifier` agent with only the new skill's absolute path and one feature ID. Its brief: follow Launch, Doctor, Drive, Evidence, and Cleanup exactly as written; do not edit any file; report the evidence paths and every step where it had to guess; do not spawn agents or run user-invoked skills. Its verdict tells you whether the skill works. Fix each guess in the skill text, then rerun. When no subagent can reach the surface, run it yourself and follow the text literally, not your memory of the repo.

After cleanup, confirm the evidence still exists at the named location: list it yourself. A cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports.

A generated skill that was never executed is a draft, not a deliverable.

## 5. Point to it

Add or update the `### Verification` sub-block of the `## Agent skills` block in AGENTS.md, in the shape of [the AGENTS.md template](../setup/templates/project/AGENTS.md): one line that names `.agents/skills/verify-<app>/`, listing every verify skill when there are several. Change nothing else in the file. With no `## Agent skills` block yet, tell the user to run `/skill:setup`, which writes it.

## 6. Hand over

Report the skill path, the surface and harness, the feature you proved with its evidence path, and every interview question left open. Tell the user to run `/skill:maintain-verify` to keep the map honest as the app changes. Suggest a cadence only if they ask.
