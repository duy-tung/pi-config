# Wide change

**One mechanical change across many call sites, or a migration. You own the lever and the count.**

1. **Build the lever.** Make the first change by hand, then build the tool that makes the rest: `ast_grep_search` counts the pattern and `ast_grep_replace` is the codemod (activate them with `pi_lens_activate_tools`); a script or generator is the fallback. Prove the tool by re-running it on a clean checkout and diffing against your hand-made change. The tool (the ast-grep pattern and rewrite, or the script) is the artifact a reviewer can rerun.
2. **Choose the path.**
   - You own every caller and it fits one session: migrate callers and delete the old API in one wave. No compatibility layer.
   - External callers, or longer than one session: expand, migrate, contract. Tell the user to run `/skill:to-tickets` to cut an expand ticket, migration batches sized by blast radius, and a contract ticket blocked by every batch.
3. **Count.** Write the command that counts remaining old usages (for example `rg -c "oldApi\(" | wc -l`). Done means zero.
4. **Sequence verifiable units.** Each batch ends green before the next starts.
5. **Prove** on the real artifact: load the `prove` skill. **Review**: load the `interrogate` skill and run it with `<commit before this work> fix`.
6. **Unattended.** For a long migration, tell the user to run `/skill:afk` with the predicate "zero old callers, all tests green, old API deleted".

**Reply:** the lever and its proof, callers migrated versus remaining with the count command, the verdict.
