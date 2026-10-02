# Issue trackers

## Recommend

| Exploration found | Recommend | Template |
|---|---|---|
| A remote on `github.com` or a GitHub Enterprise host | GitHub, via `gh` | [issue-tracker-github.md](templates/project/docs/agents/issue-tracker-github.md) |
| A remote on `gitlab.com` or a self-hosted GitLab | GitLab, via `glab` | [issue-tracker-gitlab.md](templates/project/docs/agents/issue-tracker-gitlab.md) |
| No remote, or `.scratch/` already in use | Local markdown under `.scratch/` | [issue-tracker-local.md](templates/project/docs/agents/issue-tracker-local.md) |
| The user tracks work elsewhere (Jira, Linear) | Other | none: see below |

Explain only when the user hesitates: the tracker is where `/skill:to-spec` and `/skill:to-tickets` publish work and `/skill:implement` fetches it, so pick the place this repo's work is really tracked.

If `gh auth status` or `glab auth status` failed during exploration, put that next to the recommendation: skills cannot publish until the user installs the CLI or logs in.

## Other trackers

Ask for one paragraph: how to create, read, list, comment on, label and close an issue, and how one issue blocks another (a CLI, an MCP server's tools, or a web UI only). Write `docs/agents/issue-tracker.md` with the GitHub template's headings: Conventions, "When a skill says 'publish to the issue tracker'", "When a skill says 'fetch the relevant ticket'", Ticket operations. Under a heading the workflow cannot serve, write `Not supported.`
