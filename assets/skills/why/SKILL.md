---
name: why
description: "Find why code has its shape (rationale, regressions, defensive code, magic numbers) from git blame, history and PRs, plus other sources the session can reach on request. Use before changing or deleting code you do not understand."
argument-hint: "<code, pattern or decision> [deep]"
---

# Why

Investigate the motivation and intent behind code. The `how` skill answers what the code does and how it works. `why` answers what forces led to its shape.

## Posture

Work as a careful, cautious, and precise investigator. Be honest about what you know versus what you infer. [EPISTEMICS.md](EPISTEMICS.md) holds the confidence tiers and the phrasing guide: read it before you write the answer. The user's guess is a prompt for investigation, not a conclusion to validate.

## 1. Target and question

The **target** is usually a chunk of code, a pattern, a feature, or a named design decision. The **question** is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep.

If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from context: open files, recent edits, what was just discussed. State your interpretation in one line so the user can redirect, then proceed.

## 2. Code anchor (always)

Anchor the investigation in concrete code. Collect:

- the file paths and line ranges
- the key symbols (functions, classes, constants), located with `symbol_search`
- the last commits touching the target
- PR numbers from merge commits (`(#1234)` in the subject line)
- ticket IDs from commit messages and PR bodies

```bash
git blame -L <start>,<end> <file>        # last-touch commits for the target lines
git log --follow -p -- <file>            # full history with patches, through renames
git log --oneline -20 -- <file>          # recent commits, PR numbers visible
git log -1 --format=%B <commit>          # full message: PR number, ticket IDs
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Pull the PR body, comments, and reviews for every substantive commit: review threads are where the real signal usually is. Skip bot commits (Dependabot, Renovate, automated backports); they carry no motivation. When the anchor links one specific ticket, doc, or thread and a configured MCP server can read it, read that item with its `mcp__<server>__<tool>` tools. Following a link is part of the anchor. Searching is the sweep.

## 3. Choose the depth

- **Quick (default).** Synthesize from the anchor. Go to step 5.
- **Deep.** Run the sweep in step 4 only when the user asks for it (`deep`, or "dig deeper"). It spawns several investigators and reads connected tools, so never start it on your own.

When the quick answer is inconclusive, say so and offer `deep`, naming the sources it would read. Inconclusive means:
  - no claim reaches Direct or Supported for the question asked;
  - the anchor points at a ticket, doc, thread, incident, or error you could not read; or
  - the code looks defensive (null checks, retries, timeouts, rate limits, feature flags, egress guards, OOM handlers) and nothing in the anchor names what it defends against.

Say in one line of the answer which depth you ran and why.

## 4. Deep sweep

### Discover the sources

Source control (git and `gh`) is always available: [code-archaeology.md](sources/code-archaeology.md). A GitHub issue tracker is reachable through `gh`. The other categories below (long-form documents, team chat, observability, error tracking, analytics) are reachable only through a tool the session has for them, such as `mcp__<server>__<tool>` tools from Pi's built-in MCP (pi-config turns it off). No such tool means the category is a gap. Aim for a complete coverage map, not a minimal one. Document the null, don't skip the search.

### Spawn the investigators

Spawn one `researcher` investigator for source control, always, and one for each other category it can reach without MCP (a GitHub Issues tracker, through `gh`). Launch them all in one response (parallel Agent calls) so they run concurrently, and collect each full report with `get_subagent_result`. Each owns exactly one source; never ask one agent to cover two.

- Use `subagent_type: researcher`, with no model parameter. It reads whole threads and documents, and its read-only bash runs `git log -S`, `git blame` and `gh`. It has no MCP tools.
- The prompt is everything below the divider in [INVESTIGATOR.md](INVESTIGATOR.md) with its placeholders filled in, plus [code-archaeology.md](sources/code-archaeology.md) for source control, plus the code anchor and the user's question verbatim.
- Add [incident-postmortem.md](sources/incident-postmortem.md) to every brief when the target code looks defensive.
- The brief forbids writes. Investigators search and read; they never edit files, commit, comment, post, or change a ticket.
- Query any other category the session has a tool for yourself while the researchers run, following the posture in [INVESTIGATOR.md](INVESTIGATOR.md). The same rule holds: read-only calls only. Keep the queries and the verbatim excerpts with their citations: they are that category's findings for step 5.

What each category surfaces best. Use it to know what to expect back, and to name the gap when a category returns empty:

1. **Source control.** Implementation-time rationale captured during review. The only guaranteed source.
2. **Tracker.** The product or business forcing function. Strongest when the why is external to engineering.
3. **Long-form documents.** Design rationale written out before it became code.
4. **Chat.** Real-time deliberation that never reached a doc. Most important when the source control, ticket, and doc trail is thin.
5. **Infrastructure observability.** The runtime reality that motivated the code. Strongest when the target reacts to an infra signal (timeouts, retries, rate limits, circuit breakers).
6. **Error tracking.** The exceptions and error trajectories behind defensive or corrective code (catch blocks, null guards, type checks, retries).
7. **Analytics warehouse.** The product and data reality: flag-gated code, experiment-driven ships, data migrations, "where did this number come from".

### Skip only with a written reason

Every skip goes in Sources consulted with its reason. Two reasons are valid:

- **No tool reaches that category.** This is a gap, not a choice: "Real-time team chat: not searched. No tool in this session reads it, so the conversational record was not searchable."
- **The source is provably irrelevant**, not "probably irrelevant". The bar is high: "Error / exception tracking: skipped. The target is a build-time script with no runtime code path."

## 5. Synthesize

Write the answer yourself with [SYNTHESIZER.md](SYNTHESIZER.md), following [EPISTEMICS.md](EPISTEMICS.md). You own every investigator's output: open each citation the answer leans on (the PR, the ticket, the thread) before you cite it, and never propagate a citation you did not check. Never cite code as evidence for its own intent.

## 6. Present

Keep the confidence language intact, including in any one-line summary you add in chat: an Inferred claim stays hedged. When the question precedes a change to this code, end with the Preserve / Change / Avoid / Risk block from SYNTHESIZER.md.

**Recency bias** is the common failure. The most recent commit is rarely authoritative: the current shape is often the accretion of many earlier decisions. Trace back.
