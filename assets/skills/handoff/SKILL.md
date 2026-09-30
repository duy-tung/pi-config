---
name: handoff
description: "Compact the conversation into a handoff document that seeds another session, harness or person."
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the temporary directory of the user's OS (`$TMPDIR`, falling back to `/tmp`; `%TEMP%` on Windows), not the current workspace, as `handoff-<slug>-<timestamp>.md`. Tell the user the absolute path.

Include a "suggested skills" section in the document: the disciplines the next agent should load ("load the `<name>` skill"), and the commands the user should type (`/skill:<name>`).

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead. Only reference files that will outlive the temp directory.

Mark every claim you did not check this session as **unverified** ("unverified: the export job is not built yet"). The next agent treats the document as a contract and will not re-check it, so a belief written as a fact becomes a false premise.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Launch line

End by printing the line that seeds the next session:

```
Read <handoff path> and continue
```

The user opens Pi (a new terminal, or `/clear` here) and pastes it. Pass the file path, never the summary: the file is the contract the next agent reads.

If the next session will not start soon, or runs in another harness, tell the user to copy the file somewhere durable: some environments clear temp between sessions.
