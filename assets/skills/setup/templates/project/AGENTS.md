<How a request flows through this repo, in one or two sentences: entry point, main layers, where state lives.>

## Navigation

- `<hard-to-find path>`: <when to open it>.

## When something breaks

| Symptom | Cause |
|---|---|
| <what the agent sees> | <the cause, and the file or command that fixes it> |

## Agent skills

### Issue tracker
<Where issues live, in one line>. See `docs/agents/issue-tracker.md`.

### Triage labels
<Default or custom label names, in one line>. See `docs/agents/triage-labels.md`.

### Domain docs
<Single-context or multi-context>. See `docs/agents/domain.md`.

### Verification
Before calling a user-visible change done, prove it with `.agents/skills/verify-<app>/`.

### Coding standards
Review-time rules live in `CODING_STANDARDS.md`; read it when reviewing a diff.
