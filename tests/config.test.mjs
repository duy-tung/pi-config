import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildConfiguration } from "../lib/config.mjs";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
function fixture(platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:\\Users\\Dev Example" : "/home/dev example";
  const root = p.join(home, "Pi Runtime");
  const agentDir = p.join(home, "Custom Agent");
  const binDir = p.join(home, "Local Tools");
  const nodePath = platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/node/bin/node";
  const shellPath = platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  const options = { root, agentDir, binDir, nodePath, platform, home, repoDir, shellPath };
  const files = buildConfiguration(options);
  const read = (file) => {
    const found = files.find((entry) => entry.path === file);
    assert.ok(found, `Thiếu managed file ${file}`);
    return found.content;
  };
  const json = (file) => JSON.parse(read(file));
  const profiles = json(p.join(root, "profiles.json"));
  return { p, options, files, read, json, profiles };
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform}: bảo toàn bốn profile, model, thinking và phạm vi extension`, () => {
    const { p, options, json, profiles, read } = fixture(platform);
    const expected = {
      main: ["current", "openai-codex", "gpt-6-astra", "high", "rose-pine-moon"],
      goal: ["compat", "openai-codex", "gpt-6-astra", "high", "rose-pine"],
      background: ["compat", "openai-codex", "gpt-6-astra", "high", "rose-pine"],
      advisor: ["current", "openai-codex", "gpt-5.6-sol", "high", "rose-pine"],
    };
    for (const [name, profile] of Object.entries(profiles)) {
      const settings = json(p.join(profile.agentDir, "settings.json"));
      assert.deepEqual([profile.runtime, settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel, settings.theme], expected[name]);
      assert.equal(settings.modelThinkingLevels["openai-codex/gpt-6-astra"], "high");
      assert.equal(settings.modelThinkingLevels["openai-codex/gpt-5.6-sol"], "high");
      assert.equal(settings.shellPath, options.shellPath);
      assert.equal(settings.skills.length, 3);
      assert.equal(settings.extensions.length, ["main", "goal"].includes(name) ? 3 : 2);
      assert.equal(settings.extensions[0], `-${p.join(profile.agentDir, "extensions", "statusline.ts")}`);
      assert.ok(settings.packages.every((entry) => entry.startsWith(p.join(options.root, "runtimes", profile.runtime, "node_modules"))));
      const overrides = json(p.join(profile.agentDir, "models.json")).providers["openai-codex"].modelOverrides;
      assert.equal(overrides["gpt-5.6-sol"].contextWindow, 872000);
      assert.equal(overrides["gpt-6-astra"].contextWindow, 872000);
      assert.deepEqual(settings.enabledModels, ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "opencode-go/glm-5.3-flash"]);
      assert.equal(settings.modelThinkingLevels["opencode-go/glm-5.3-flash"], "max");
      assert.equal(json(p.join(profile.agentDir, "routing.json")).mode, "off");
      assert.equal(json(p.join(profile.agentDir, "routing.json")).jev, undefined);
      assert.equal(settings.extensions.some(value => value.includes("pi-dispatch-router")), ["main", "goal"].includes(name));
      for (const role of ["researcher", "worker", "debugger", "reviewer"]) {
        const agent = read(p.join(profile.agentDir, "agents", `${role}.md`));
        assert.match(agent, /^model: openai-codex\/gpt-5\.6-sol$/mu);
        assert.match(agent, /^thinking: high$/mu);
        assert.match(agent, /^inherit_context: false$/mu);
        assert.match(agent, /^isolated: false$/mu);
        assert.match(agent, /^max_turns: 12$/mu);
      }
      assert.equal(profile.packages.includes("@tintinweb/pi-subagents"), ["main", "goal"].includes(name));
      assert.equal(profile.packages.includes("pi-background-tasks"), name === "background");
      assert.equal(profile.packages.includes("pi-advisor-flow"), name === "advisor");
      assert.equal(profile.packages.includes("pi-workspace-history"), name === "goal");
    }
    assert.equal(json(p.join(options.agentDir, "pi-usage.json")).codexFastMode, true);
  });

  test(`${platform}: MCP không qua shell, đường dẫn có khoảng trắng và credential được chặn`, () => {
    const { p, options, json, profiles } = fixture(platform);
    const forward = (value) => value.replaceAll("\\", "/");
    for (const profile of Object.values(profiles)) {
      const mcp = json(p.join(profile.agentDir, "mcp.json"));
      const server = mcp.mcpServers.workspace;
      assert.equal(server.command, options.nodePath);
      assert.deepEqual(server.args, [p.join(options.root, "bin", "workspace-mcp.mjs")]);
      assert.equal(server.inheritEnv, false);
      assert.equal(server.cwd, "${PI_WORKSPACE_DIR}");
      assert.equal(server.lifecycle, "lazy");
      assert.deepEqual(server.includeTools, ["read_text_file", "list_directory", "get_file_info", "list_allowed_directories"]);
      const { permission } = json(p.join(profile.agentDir, "extensions", "pi-permission-system", "config.json"));
      for (const deny of [p.join(options.agentDir, "auth.json"), p.join(options.root, "profiles", "*", "auth.json"), p.join(options.root, "secrets", "*.env"), p.join(options.agentDir, "compact-adviser.json")]) {
        assert.equal(permission.path[forward(deny)], "deny", deny);
      }
      assert.equal(permission.mcpScript, "deny");
      assert.equal(permission.bash["*firecrawl-key.cjs*"], "deny");
      assert.equal(permission["*"], "ask");
      const firecrawl = json(p.join(profile.agentDir, "web-search.json"));
      assert.equal(firecrawl.provider, "firecrawl");
      assert.equal(firecrawl.searchRouting.useCurrentModel, false);
      assert.equal(firecrawl.allowBrowserCookies, false);
      assert.match(firecrawl.firecrawlApiKey, /^!/u);
      assert.ok(firecrawl.firecrawlApiKey.includes(options.nodePath));
      assert.ok(firecrawl.firecrawlApiKey.includes(p.join(options.root, "bin", "firecrawl-key.cjs")));
      const credentialRoot = platform === "darwin" ? p.join(options.home, "Library", "Application Support", "firecrawl-cli", "*")
        : platform === "win32" ? p.join(options.home, "AppData", "Roaming", "firecrawl-cli", "*")
          : p.join(options.home, ".config", "firecrawl-cli", "*");
      assert.equal(permission.path[forward(credentialRoot)], "deny");
    }
  });

  test(`${platform}: không xuất credential, không tự bật tác vụ có phí`, () => {
    const { p, options, files, json, profiles } = fixture(platform);
    assert.equal(new Set(files.map(({ path: file }) => file)).size, files.length);
    for (const file of files) {
      assert.equal(file.mode, 0o600);
      assert.notEqual(p.basename(file.path), "auth.json");
      assert.doesNotMatch(file.path, /sessions|mcp-cache|models-store/u);
      assert.doesNotMatch(file.content, /\/Users\/tung|apikey_[a-z0-9]|fc-[a-f0-9]{20}|TYPESAFE_API_KEY=/u);
    }
    for (const profile of Object.values(profiles)) {
      assert.ok(!profile.packages.includes("compact-adviser"));
      for (const retired of ["compact-adviser.json", "routing-capabilities.json"]) {
        assert.ok(!files.some(file => file.path === p.join(profile.agentDir, retired)));
      }
      const routing = json(p.join(profile.agentDir, "routing.json"));
      assert.equal(routing.version, 2); assert.equal(routing.mode, "off");
      assert.equal(routing.jev, undefined);
      const advisor = json(p.join(profile.agentDir, "advisor.json"));
      assert.equal(advisor.alwaysOn, false);
      assert.equal(advisor.advisorAutoLoopGate, false);
      assert.equal(advisor.executor, "openai-codex/gpt-5.6-sol");
      assert.equal(advisor.executorEffort, "high");
      assert.equal(advisor.advisor, "openai-codex/gpt-6-astra");
      assert.equal(advisor.advisorEffort, "high");
      const auditor = json(p.join(profile.agentDir, "pi-goal-x-settings.json"));
      assert.equal(auditor.provider, "openai-codex");
      assert.equal(auditor.model, "gpt-5.6-sol");
      assert.equal(json(p.join(profile.agentDir, "pi-goal-x-settings.json")).disabled, true);
      assert.equal(json(p.join(profile.agentDir, "settings.json")).cacheWarming, "off");
      assert.equal(json(p.join(profile.agentDir, "subagents.json")).fallbackSubagent, "none");
    }
    assert.equal(json(p.join(options.root, "config", "pi-lens.json")).format.enabled, false);
    assert.ok(files.every(({ path: file }) => file !== p.join(options.home, ".pi-lens", "config.json")));
  });
}

test("POSIX credential helper chạy đúng khi root chứa khoảng trắng, nháy đơn và shell metacharacters", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-quote-"));
  try {
    const root = path.join(dir, "Dev's runtime $(touch SHOULD_NOT_EXIST)");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "firecrawl-key.cjs"), 'process.stdout.write("fixture-credential");\n');
    const agentDir = path.join(dir, "Agent");
    const generated = buildConfiguration({ root, agentDir, binDir: path.join(dir, "bin"), nodePath: process.execPath, platform: "linux", home: dir, repoDir });
    const config = JSON.parse(generated.find(({ path: file }) => file === path.join(agentDir, "web-search.json")).content);
    const output = execFileSync("/bin/sh", ["-c", config.firecrawlApiKey.slice(1)], { cwd: dir, encoding: "utf8" });
    assert.equal(output, "fixture-credential");
    assert.equal(fs.existsSync(path.join(dir, "SHOULD_NOT_EXIST")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows không chấp nhận expansion characters nguy hiểm cho cmd credential helper", () => {
  const { options } = fixture("win32");
  for (const suffix of ["%TEMP%", 'bad"quote', "!TEMP!", "bad\nline"]) {
    assert.throws(() => buildConfiguration({ ...options, root: `${options.root} ${suffix}` }), /Đường dẫn/u);
  }
});

test("Windows credential helper chạy thật qua cmd với đường dẫn có khoảng trắng", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-quote-"));
  try {
    const root = path.join(dir, "Runtime With Spaces & Symbol");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "firecrawl-key.cjs"), 'process.stdout.write("fixture-credential");\n');
    const agentDir = path.join(dir, "Agent");
    const generated = buildConfiguration({ root, agentDir, binDir: path.join(dir, "bin"), nodePath: process.execPath, platform: "win32", home: dir, repoDir });
    const config = JSON.parse(generated.find(({ path: file }) => file === path.join(agentDir, "web-search.json")).content);
    assert.equal(execSync(config.firecrawlApiKey.slice(1), { cwd: dir, encoding: "utf8", windowsHide: true }), "fixture-credential");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Đầu vào tương đối bị từ chối để không ghi nhầm workspace", () => {
  const { options } = fixture("linux");
  assert.throws(() => buildConfiguration({ ...options, agentDir: ".pi/agent" }), /agentDir phải là đường dẫn tuyệt đối/u);
});
