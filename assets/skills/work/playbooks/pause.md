# Pause

**You own a clean stop.** Only on an explicit request. On "keep going" or "going to bed, keep going", do not pause.

1. **Stop at a safe boundary.** Finish or back out of the current atomic step. Start nothing new. Let running agents finish, or stop them through `/agents`. An active goal would auto-continue: pause it (`update_goal {status: "paused", reason}`, like the user's `/goal-pause`), which keeps it resumable.
2. **No irreversible action to pause.** No new PR, no push you did not already have.
3. **Make the work durable.** Commit uncommitted edits as one `wip:` commit on the current branch. If the tree is broken, say so in one line of the commit body.
4. **Write the resume note** to `.tstack/<slug>/resume.md` (the OS temp dir outside a repo): intent, what you were doing, progress and what is verified, next steps, key files, gotchas. Point at an existing decision log instead of copying it.

**Reply:** where you are, what is on disk versus only in this conversation (paths, no diff dumps), the commits and whether the tree is clean, the first action on resume.
