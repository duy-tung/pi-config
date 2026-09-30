---
name: resolving-merge-conflicts
description: "Resolve an in-progress git merge, rebase, or cherry-pick conflict by each side's intent. Use when git reports conflicts or a merge or rebase has stopped midway."
---

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them, typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage the files you resolved or fixed by name (`git add <paths>`, never `-A`: unrelated local files stay out), then `git commit --no-edit` for a merge, or `GIT_EDITOR=true git rebase --continue` / `GIT_EDITOR=true git cherry-pick --continue` (no editor can open in this shell). Repeat for each stop until the rebase is done.
