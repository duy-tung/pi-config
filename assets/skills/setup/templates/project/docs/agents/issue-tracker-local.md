# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- A `Category:` line holds `bug` or `enhancement`.
- Work state is a `Status:` line: `open` (the default when the line is absent), `claimed` or `resolved`
- Blocking edges are a `Blocked by: NN, NN` line near the top of the issue file. A ticket is unblocked when every file it lists has `Status: resolved`
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- **Close**: append what landed under `## Comments`, then set `Status: resolved`

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Ticket operations

Blocking, frontier and claim for the tickets `/skill:to-tickets` publishes.

- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<feature-slug>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`.
