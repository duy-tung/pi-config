---
name: research
description: "Investigate a question against primary sources in a background agent and save cited findings as one Markdown file. Use to gather docs or API facts, or to delegate reading legwork."
---

Spin up a **`researcher` agent** to do the research (it runs in the background), so you keep working while it reads. One agent per question; several questions go out in one response (parallel Agent calls). Researchers use `web_search` and `fetch_content`; call `web_enable` first if those tools are not listed. The research agent must not spawn further agents: if you are already a subagent, do the research yourself in this context.

Scope each question first: one API, one behaviour, one version claim. Split a broad topic into narrow questions.

Researchers have no MCP tools. If the user configured Context7 or another documentation MCP server, query it yourself through the `mcp` proxy and put the relevant excerpt in the brief.

Brief each agent with its question and this job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it. When docs and the installed version's source disagree, the source wins.
2. Stop when each question has a primary-source citation or is marked unanswerable, with where you looked.
3. Return the findings as one Markdown document, citing each claim's source. Head it with the date and the versions the findings apply to.
4. End with a three-line gist.
5. Do not spawn agents or run user-invoked skills. Do the work directly.

Researchers cannot write files. Collect each report's full text with `get_subagent_result` and save it yourself as a single Markdown file: where the user said, otherwise where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible. Report the file path and the three-line gist.
