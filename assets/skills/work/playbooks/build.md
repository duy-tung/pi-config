# Build

The implementation loop for one ticket or one small spec. Used by `/skill:implement`, the feature playbook and `worker` agents briefed by `afk`.

**You own the diff and its proof.** A unit is done when it is proven on the real artifact, reviewed, committed and closed.

Inputs: a ticket or spec (fetch it with the workflow in the issue tracker doc when given a number or URL; the `## Agent skills` block in AGENTS.md points to it), its acceptance criteria, and its `Verify:` line when present.

1. **Read the work item and its parent spec.** An issue labelled `spec` that has tickets is a destination, not a buildable unit: build its tickets instead. A spec with no tickets is buildable only in an attended run and only when it fits one smart zone; its user stories are the acceptance criteria. List the acceptance criteria. Each must be observable; rewrite any that is not, and say so.
2. **Name the data shape** and the structure it hangs on before writing logic (a state machine over scattered booleans, a registry over a growing if/else chain, a typed model over repeated shape assumptions). One or two lines on the `todo` list.
3. **Design check.** If the change crosses a module boundary or adds a public interface, load the `codebase-design` skill and follow its ARCHITECT.md: caller usage first, then types. Skip it when the shape is already concrete.
4. **Agree the seams.** Use the seams the spec or ticket names. Otherwise propose the highest existing seam and confirm it with the user. Unattended, never invent a seam: log the gap and rely on step 7.
5. **Build one vertical slice at a time**, test first at the agreed seams: load the `tdd` skill. Red before green. Run the typechecker and the single affected test file often, the full suite once at the end.
6. **Keep the diff honest.** No speculative code. No compatibility shims for callers you own. No narrating comments. No new lint or type suppressions. Use the existing helper instead of a second path. Follow `CODING_STANDARDS.md` when present.
7. **Prove it.** Load the `prove` skill and run it with the acceptance criteria and the ticket's `Verify:` line. For work you wrote it spawns the `verifier` agent. NOT VERIFIED means not done: fix and prove again, or report it. INCONCLUSIVE is not a pass.
8. **Commit** in small ordered commits with Conventional Commit messages. Stage named files only (`git add <files>`, never `-A`). Never bypass hooks (`--no-verify`, `HUSKY=0`).
9. **Review.** Load the `interrogate` skill and run it with `<commit before this work> fix`. It fixes Act-on items and re-runs the affected axes once. If a fix changed behavior, prove again.
10. **Close out.** Tick the acceptance criteria, comment what landed (commit SHAs, verdict, evidence path) and close the ticket with the issue tracker doc's close command so dependent tickets unblock. Never close or edit the parent spec of a ticket. A spec you built directly (step 1) closes like a ticket.

**Reply:** what landed (SHAs), the data shape, the verdict with evidence paths, review items still open, tickets now unblocked, and the phase-boundary call for the next ticket (usually clear: the spec, tickets and commits hold the context).
