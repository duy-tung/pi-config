# Review comment triage

For every review thread on a PR, from bots (Bugbot, Claude or Copilot review, security scanners) and humans alike. The goal is not to ignore bots by default. The goal is to stop treating every comment as a required code change.

## Decide

Classify each thread before acting:

- **fix**: a plausible correctness, security, privacy, data loss, auth, billing, migration, idempotency, race, or shipped-behavior issue. Fix it in the lowest PR that owns the code, red first, then reply with the commit SHA and resolve the thread.
- **dismiss**: the comment matches a known low-risk pattern below and the current code proves no change is needed. Reply with a short, concrete reason and resolve the thread.
- **ask**: novel, high-severity, security, privacy or data related, or ambiguous. Ask the user instead of guessing.

When in doubt, ask. Skipping a noisy style comment is cheap. Skipping a real data or security bug is not.

**Verify cheap claims before classifying.** When a comment claims a test and its target disagree, or that a guard is missing, run the test or read the tip first. A red run confirms the claim. A green run is the concrete reason for a dismissal.

## Ask by default

Never auto-dismiss these, even if a similar comment was dismissed before:

- Security, privacy, auth, billing, data retention and permission-boundary findings.
- High-severity findings.
- Migration, schema, idempotency, concurrency and cross-system behavior findings.
- Comments whose suggested fix is small and clearly reduces risk without changing product intent.

## Known low-risk patterns

Each pattern states when it may be dismissed and when it may not.

### Intentional visual change
- Dismiss when: the PR description, screenshots or nearby code make the visual change explicit, and the comment only restates that a shared visual default changed.
- Do not dismiss when: it concerns accessibility, focus visibility, keyboard navigation, color contrast, or a component API the PR did not mean to change.

### Usage the reviewer cannot see
- Dismiss when: an export or helper is flagged unused, and a later PR in the same stack verifiably uses it.
- Do not dismiss when: the PR is not in a stack, the symbol is public API, or the later use cannot be verified.

### Temporary duplication during a planned replacement
- Dismiss when: a small duplication keeps a new path parallel to an old path that a ticket already schedules for deletion.
- Do not dismiss when: the duplicated code touches security, billing, data access or API behavior.

### An existing invariant already covers it
- Dismiss when: a shared component, framework contract, type or single source of truth visible in the code guarantees the concern.
- Do not dismiss when: the invariant is assumed but not enforced, depends on timing, or crosses async or state boundaries.

### Owner-declared follow-up
- Dismiss when: the PR owner (the user) says it is a known follow-up, the PR does not make it worse, and it is not high risk.
- Do not dismiss when: you are acting without the owner's word, or deferring would merge a new regression.

### Stale finding already fixed on the tip
- Dismiss when: the flagged gate or validation exists on the current tip, with a test, because a later commit added it.
- Do not dismiss when: the cited helper is a no-op for the case in question, or the check runs after the side effect it guards.

### Narrow error handling on purpose
- Dismiss when: the comment asks to widen a deliberately narrow error condition (a specific errno or status code) into a catch-all, and the narrowness separates two different situations (a missing binary versus a failed command).
- Do not dismiss when: the narrow condition misses a case in the same category, or the unhandled path loses data.

## Growing this file

After a babysit, add a pattern that recurred in the shape above, with a confidence level: `candidate` for one or two examples, `recurring` after several verified dismissals, `strong` only for narrow, repeatedly verified, low-risk patterns. Never turn one owner's dismissal of a security comment into a pattern.
