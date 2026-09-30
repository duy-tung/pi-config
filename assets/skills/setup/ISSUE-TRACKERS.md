# Issue trackers

## Recommend

| Exploration found | Recommend | Template |
|---|---|---|
| A remote on `github.com` or a GitHub Enterprise host | GitHub, via `gh` | [issue-tracker-github.md](templates/project/docs/agents/issue-tracker-github.md) |
| A remote on `gitlab.com` or a self-hosted GitLab | GitLab, via `glab` | [issue-tracker-gitlab.md](templates/project/docs/agents/issue-tracker-gitlab.md) |
| No remote, or `.scratch/` already in use | Local markdown under `.scratch/` | [issue-tracker-local.md](templates/project/docs/agents/issue-tracker-local.md) |
| The user tracks work elsewhere (Jira, Linear) | Other | none: see below |

Explain only when the user hesitates: the tracker is where `/skill:to-spec`, `/skill:to-tickets`, `/skill:triage` and `/skill:wayfinder` publish and fetch work, so pick the place this repo's work is really tracked.

If `gh auth status` or `glab auth status` failed during exploration, put that next to the recommendation: skills cannot publish until the user installs the CLI or logs in.

Leave the "PRs as a request surface" flag at `no` and do not raise it.

## Other trackers

Ask for one paragraph: how to create, read, list, comment on, label and close an issue, and how one issue blocks another (a CLI, an MCP server's tools, or a web UI only). Write `docs/agents/issue-tracker.md` with the GitHub template's headings: Conventions, "When a skill says 'publish to the issue tracker'", "When a skill says 'fetch the relevant ticket'", Wayfinding operations. Under a heading the workflow cannot serve, write `Not supported.`

## Triage labels

The seven roles (two categories, five states) and their default names are in [triage-labels.md](templates/project/docs/agents/triage-labels.md). When the user keeps the defaults, write it as is. Otherwise collect the names their tracker already uses (for example `bug:triage` for `needs-triage`) into the right-hand column, so skills apply existing labels instead of creating duplicates.

Create the labels after the user approves the drafts. Use the Meaning column as the description.

- **GitHub**: read `gh label list --limit 500 --json name`, then `gh label create "<label>" --description "<meaning>"` for each missing label. Never overwrite an existing label: its color and description belong to the repo.
- **GitLab**: read `glab label list`, then `glab label create --name "<label>" --description "<meaning>"` for each missing label.
- **Local**: nothing to create. The `Triage:` and `Category:` lines in each issue file carry the roles.
