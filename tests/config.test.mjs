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
  test(`${platform}: một cấu hình Pi, model, thinking và phạm vi extension`, () => {
    const { p, options, json, profiles, read, files } = fixture(platform);
    const expected = {
      main: ["current", "anthropic", "claude-opus-5-5", "high", "rose-pine-moon"],
    };
    assert.deepEqual(Object.keys(profiles), ["main"]);
    for (const [name, profile] of Object.entries(profiles)) {
      const settings = json(p.join(profile.agentDir, "settings.json"));
      assert.deepEqual([profile.runtime, settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel, settings.theme], expected[name]);
      assert.deepEqual(settings.modelThinkingLevels, {
        "anthropic/claude-opus-5-5": "high", "openai-codex/gpt-6-sol": "max",
        "openai-codex/gpt-6-astra": "high", "opencode-go/glm-5.3-flash": "max",
      });
      assert.equal(settings.shellPath, options.shellPath);
      assert.equal(settings.skills.length, 3);
      assert.deepEqual(settings.extensions, ["rose-pine-palette.ts", "pi-rewind", "claude-usage", "pi-auto-mode"]
        .map((entry) => p.join(options.root, "assets", "extensions", entry)));
      assert.equal(settings.doubleEscapeAction, "none");
      assert.deepEqual(settings.rewind, { storageDir: p.join(options.root, "state", "rewind"), retentionDays: 30 });
      assert.equal(settings.workspaceHistory, undefined);
      const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, "manifests", "current", "package.json"), "utf8"));
      assert.equal(settings.lastChangelogVersion, manifest.dependencies["@earendil-works/pi-coding-agent"]);
      assert.ok(settings.packages.every((entry) => (typeof entry === "string" ? entry : entry.source).startsWith(p.join(options.root, "runtimes", profile.runtime, "node_modules"))));
      const providers = json(p.join(profile.agentDir, "models.json")).providers;
      assert.deepEqual(Object.keys(providers), ["openai-codex"], "Opus 5.5 dùng context 1M của catalog");
      assert.deepEqual(providers["openai-codex"].modelOverrides, { "gpt-6-sol": { contextWindow: 872000 }, "gpt-6-astra": { contextWindow: 872000 } });
      assert.deepEqual(settings.enabledModels, ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra", "opencode-go/glm-5.3-flash"]);
      if (name === "main") {
      const roles = {
        researcher: ["opencode-go/glm-5.3-flash", "max"], worker: ["openai-codex/gpt-6-sol", "max"],
        debugger: ["openai-codex/gpt-6-sol", "max"], reviewer: ["openai-codex/gpt-6-astra", "high"],
      };
      for (const [role, [model, thinking]] of Object.entries(roles)) {
        const agent = read(p.join(profile.agentDir, "agents", `${role}.md`)).replaceAll("\r\n", "\n");
        const field = (key) => agent.match(new RegExp(`^${key}: (.+)$`, "mu"))?.[1];
        assert.equal(field("model"), model, role);
        assert.equal(field("thinking"), thinking, role);
        assert.ok(settings.enabledModels.includes(model), role);
        assert.equal(field("inherit_context"), "false");
        assert.equal(field("isolated"), "false");
        assert.equal(field("max_turns"), "0", "Không giới hạn số lượt");
        // Worker/debugger ghi file nên chạy foreground; pi-usage áp Codex fast mode cho request của chúng.
        const writer = role === "worker" || role === "debugger";
        assert.equal(field("run_in_background"), writer ? "false" : undefined, role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-usage"), writer, role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-web-access"), role === "researcher", role);
      }
      const subagents = json(p.join(profile.agentDir, "subagents.json"));
      assert.deepEqual([subagents.maxConcurrent, subagents.maxConcurrentForeground, subagents.defaultMaxTurns, subagents.backgroundByDefault], [4, 2, 0, true]);
      assert.equal(files.filter(file=>file.path.startsWith(p.join(profile.agentDir,"agents")+p.sep)).length,4);
      } else {
        assert.ok(!files.some(file => file.path.startsWith(p.join(profile.agentDir,"agents")+p.sep)));
      }
      assert.equal(profile.packages.includes("@tintinweb/pi-subagents"), name === "main");
      assert.equal(profile.packages.includes("pi-background-tasks"), true);
      assert.deepEqual(settings.packages.find(entry=>typeof entry === "object").extensions,["dist/extensions/background-tasks.js"]);
      assert.equal(profile.packages.includes("pi-advisor-flow"), name === "main");
      assert.equal(profile.packages.includes("pi-workspace-history"), false);
    }
    assert.equal(json(p.join(options.agentDir, "pi-usage.json")).codexFastMode, true);
  });

  test(`${platform}: MCP không qua shell, đường dẫn có khoảng trắng và credential được chặn`, () => {
    const { p, options, json, profiles, files } = fixture(platform);
    const forward = (value) => value.replaceAll("\\", "/");
    for (const profile of Object.values(profiles)) {
      const mcp = json(p.join(profile.agentDir, "mcp.json"));
      assert.deepEqual(mcp.settings, { hostConfigDiscovery: "off", allowInstall: false });
      const server = mcp.mcpServers.workspace;
      assert.equal(server.command, options.nodePath);
      assert.deepEqual(server.args, [p.join(options.root, "bin", "workspace-mcp.mjs")]);
      assert.equal(server.inheritEnv, false);
      assert.equal(server.cwd, "${PI_WORKSPACE_DIR}");
      assert.equal(server.lifecycle, "lazy");
      assert.deepEqual(server.includeTools, ["read_text_file", "list_directory", "get_file_info", "list_allowed_directories"]);
      const settings = json(p.join(profile.agentDir, "settings.json"));
      const deny = settings.permissions.deny;
      for (const file of [p.join(options.agentDir, "auth.json"), p.join(options.root, "profiles", "*", "auth.json"), p.join(options.root, "secrets", "*.env"), p.join(options.home, ".codex", "auth.json")]) {
        assert.ok(deny.includes(`Path(${forward(file)})`), file);
      }
      assert.ok(deny.includes("mcpScript"));
      assert.ok(deny.includes("Bash(*firecrawl-key.cjs*)"));
      assert.ok(deny.includes("!Path(*.env.example)"));
      // Xoá đệ quy do pi-auto-mode hỏi (bypass) hoặc phân loại (auto), không chặn cứng theo một cách viết cờ.
      assert.ok(!deny.some((rule) => rule.startsWith("Bash(rm ")));
      assert.equal(settings.permissions.defaultMode, "auto");
      assert.equal(settings.autoMode.model, "openai-codex/gpt-6-sol");
      assert.ok(settings.extensions.at(-1).endsWith("pi-auto-mode"), "pi-auto-mode phải nạp sau cùng");
      assert.ok(!settings.packages.some((entry) => String(entry?.source ?? entry).includes("pi-permission-system")));
      assert.ok(!files.some((file) => file.path.includes("pi-permission-system")));
      assert.deepEqual(json(p.join(profile.agentDir, "keybindings.json"))["app.thinking.cycle"], ["alt+t"]);
      const firecrawl = json(p.join(profile.agentDir, "web-search.json"));
      // provider cố định sẽ bỏ qua searchRouting; native search theo model (Codex, Claude) đi trước, Firecrawl dự phòng.
      assert.equal(firecrawl.provider, undefined);
      assert.deepEqual(firecrawl.searchRouting.providers, ["openai", "anthropic", "exa", "firecrawl"]);
      assert.equal(firecrawl.searchRouting.useCurrentModel, true);
      assert.deepEqual(firecrawl.searchRouting.fallbackOn, ["network", "transient", "quota", "invalid-response", "unsupported"]);
      assert.deepEqual(firecrawl.webSearch.allowedProviders, ["openai", "anthropic", "exa", "firecrawl"]);
      assert.equal(firecrawl.anthropicSearch, undefined, "Model khác Claude không tìm bằng Claude nếu người dùng không bật");
      assert.equal(firecrawl.exaApiKey, undefined, "Exa không cần key: dùng endpoint MCP miễn phí");
      assert.deepEqual(settings.permissions.ask, ["Edit(**/.pi/pi-goal-x-settings.json)"]);
      assert.deepEqual(firecrawl.fetchRouting.providers, ["firecrawl"]);
      assert.ok(settings.permissions.allow.includes("web_search"));
      assert.equal(firecrawl.allowBrowserCookies, false);
      assert.match(firecrawl.firecrawlApiKey, /^!/u);
      assert.ok(firecrawl.firecrawlApiKey.includes(options.nodePath));
      assert.ok(firecrawl.firecrawlApiKey.includes(p.join(options.root, "bin", "firecrawl-key.cjs")));
      const credentialRoot = platform === "darwin" ? p.join(options.home, "Library", "Application Support", "firecrawl-cli", "*")
        : platform === "win32" ? p.join(options.home, "AppData", "Roaming", "firecrawl-cli", "*")
          : p.join(options.home, ".config", "firecrawl-cli", "*");
      assert.ok(deny.includes(`Path(${forward(credentialRoot)})`));
    }
  });

  test(`${platform}: không xuất credential; advisor, goal auditor và Oracle đúng cấu hình đã chọn`, () => {
    const { p, options, files, json, profiles } = fixture(platform);
    assert.equal(new Set(files.map(({ path: file }) => file)).size, files.length);
    for (const file of files) {
      assert.equal(file.mode, 0o600);
      assert.notEqual(p.basename(file.path), "auth.json");
      assert.doesNotMatch(file.path, /sessions|mcp-cache|models-store/u);
      assert.doesNotMatch(file.content, /\/Users\/tung|apikey_[a-z0-9]|fc-[a-f0-9]{20}|[A-Z_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)=/u);
    }
    for (const profile of Object.values(profiles)) {
      if (profile.packages.includes("pi-advisor-flow")) {
      const advisor = json(p.join(profile.agentDir, "advisor.json"));
      const settings = json(p.join(profile.agentDir, "settings.json"));
      // Luôn bật với executor là chính model mặc định (Opus/high), nên mở phiên không đổi model.
      assert.equal(advisor.alwaysOn, true);
      assert.equal(advisor.executor, `${settings.defaultProvider}/${settings.defaultModel}`);
      assert.equal(advisor.executorEffort, settings.defaultThinkingLevel);
      assert.equal(advisor.advisor, "openai-codex/gpt-6-astra");
      assert.equal(advisor.advisorEffort, "high");
      // Gate là hướng dẫn trong prompt: khi lỗi lặp lại và trước khi báo xong; không có gate cứng chặn phiên.
      assert.deepEqual([advisor.advisorPlanGate, advisor.advisorFailureGate, advisor.advisorCompletionGate], [false, true, true]);
      assert.equal(advisor.advisorAutoLoopGate, false);
      assert.equal(advisor.gateFailureMode, "warn-and-continue");
      assert.equal(advisor.advisorMaxCallsPerSession, 5);
      // Diff đầy đủ chiếm tối đa một nửa contextMaxChars: 20.000 ký tự diff, còn ít nhất 40.000 cho hội thoại.
      assert.equal(advisor.advisorGitContext, "full");
      assert.ok(advisor.contextMaxChars >= 2 * advisor.advisorGitContextMaxChars);
      assert.equal(advisor.advisorRedactSecrets, true);
      assert.equal(advisor.advisorTrackedFileContent, false);
      assert.equal(advisor.advisorUntrackedContent, false);
      } else assert.ok(!files.some(file => file.path === p.join(profile.agentDir,"advisor.json")));
      if (profile.packages.includes("pi-goal-x")) {
      const goal = json(p.join(profile.agentDir, "pi-goal-x-settings.json"));
      assert.equal(goal.disabled, false);
      assert.deepEqual([goal.provider, goal.model, goal.thinkingLevel], ["openai-codex", "gpt-6-astra", "high"]);
      assert.equal(goal.auditorProjectResources, false);
      assert.deepEqual(goal.oracle, { enabled: true, provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "high" });
      assert.equal(goal.maxAutonomousRuns, 10);
      } else assert.ok(!files.some(file => file.path === p.join(profile.agentDir,"pi-goal-x-settings.json")));
      assert.equal(json(p.join(profile.agentDir, "settings.json")).cacheWarming, "off");
      if (profile.packages.includes("@tintinweb/pi-subagents")) assert.equal(json(p.join(profile.agentDir, "subagents.json")).fallbackSubagent, "none");
      else assert.ok(!files.some(file => file.path === p.join(profile.agentDir,"subagents.json")));
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
