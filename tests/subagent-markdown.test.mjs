import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Bản vá pi-subagents src/index.ts: kết quả agent (mở rộng) hiện dạng Markdown qua component thật của Pi;
// dạng thu gọn giữ nguyên văn bản. Dùng runtime của bản cài, không gọi model.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("kết quả subagent mở rộng hiện Markdown, thu gọn giữ văn bản thô", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-markdown-")));
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() };
  process.env.PI_CODING_AGENT_DIR = path.join(temp, "agent");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
  process.chdir(temp);
  try {
    const modules = path.join(root, "runtimes", "current", "node_modules");
    const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
    sdk.initTheme("dark", false);
    const loaded = await sdk.discoverAndLoadExtensions([path.join(modules, "@tintinweb", "pi-subagents")], temp, process.env.PI_CODING_AGENT_DIR);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find((item) => item.tools.has("Agent"));
    const strip = (line) => line.replace(/\x1b\[[0-9;]*m/gu, "").replace(/\x1b\]8;;[^\x07]*\x07/gu, "").trim();
    const render = (name, result, expanded) => {
      const component = new sdk.ToolExecutionComponent(name, "call-1", {}, {}, extension.tools.get(name).definition, { requestRender() {} }, temp);
      component.setArgsComplete();
      component.markExecutionStarted();
      component.updateResult({ ...result, isError: false }, false);
      component.setExpanded(expanded);
      return component.render(80).map(strip);
    };
    const markdown = "## Findings\n\n- **Parser** handles `CRLF` input";
    const header = "Agent: a1\nType: worker | Status: completed | Tool uses: 3 | Duration: 12s\nDescription: Audit parser\n\n";
    const fetched = { content: [{ type: "text", text: header + markdown }], details: undefined };
    const expanded = render("get_subagent_result", fetched, true);
    assert.ok(expanded.includes("Findings"), expanded.join("\n"));
    assert.ok(!expanded.some((line) => line.startsWith("##") || line.includes("**Parser**")), expanded.join("\n"));
    assert.ok(expanded.some((line) => line.startsWith("Type: worker | Status: completed")));
    assert.ok(render("get_subagent_result", fetched, false).includes("## Findings"));
    const agent = render("Agent", {
      content: [{ type: "text", text: `Agent completed in 12.3s (3 tool uses).\n\n${markdown}` }],
      details: { displayName: "worker", description: "Audit parser", subagentType: "worker", toolUses: 3, turnCount: 2, durationMs: 12300, status: "completed", agentId: "a1" },
    }, true);
    assert.ok(agent.includes("Findings") && !agent.some((line) => line.startsWith("##")), agent.join("\n"));
  } finally {
    process.chdir(saved.cwd);
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
