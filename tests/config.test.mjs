import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildConfiguration } from "../lib/config.mjs";
import { changedRoles, fillRoleNames, forceNativeModels, loadPresets, nativeKind, nativeValues, nextModelDefault, resolveModelRoles } from "../runtime/model-roles.mjs";

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
        // Worker/debugger ghi file nên chạy foreground. Role Codex (Sol, Astra) nạp pi-usage để request fast có chi phí đúng.
        const writer = role === "worker" || role === "debugger";
        assert.equal(field("run_in_background"), writer ? "false" : undefined, role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-usage"), model.startsWith("openai-codex/"), role);
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
      assert.ok(deny.includes("Bash(*pi-mcp-adapter.service-key*)"), "Agent không đọc key Jev trong keyring");
      assert.ok(deny.includes("!Path(*.env.example)"));
      // Xoá đệ quy do pi-auto-mode hỏi (bypass) hoặc phân loại (auto), không chặn cứng theo một cách viết cờ.
      assert.ok(!deny.some((rule) => rule.startsWith("Bash(rm ")));
      assert.equal(settings.permissions.defaultMode, "auto");
      assert.equal(settings.autoMode.model, "anthropic/claude-sonnet-5");
      // Giai đoạn 1 là Jev khi có key, model ghim phiên bản (ngưỡng chỉnh theo phiên bản).
      assert.deepEqual(settings.autoMode.jev, { model: "jev-1.13.0", flagAt: 0.3, riskAt: 0.5, probe: true });
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
      const credentialRoot = platform === "darwin" ? p.join(options.home, "Library", "Application Support", "firecrawl-cli")
        : platform === "win32" ? p.join(options.home, "AppData", "Roaming", "firecrawl-cli")
          : p.join(options.home, ".config", "firecrawl-cli");
      // Thư mục bí mật: chặn cả chính thư mục (tar/cp -r/grep -r) và mọi cấp bên trong (vd ~/.aws/sso/cache).
      for (const dir of [credentialRoot, p.join(options.home, ".ssh"), p.join(options.home, ".aws"), p.join(options.home, ".config", "gcloud"), p.join(options.root, "backups")]) {
        assert.ok(deny.includes(`Path(${forward(dir)})`), dir);
        assert.ok(deny.includes(`Path(${forward(p.join(dir, "**"))})`), dir);
        assert.ok(!deny.includes(`Path(${forward(p.join(dir, "*"))})`), `${dir}: * chỉ khớp một cấp`);
      }
      assert.ok(deny.includes("Path(~/.gnupg)") && deny.includes("Path(~/.gnupg/**)"));
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
    const lens = json(p.join(options.root, "config", "pi-lens.json"));
    assert.equal(lens.format.enabled, false);
    // tsserver không tự npm install @types vào cache của máy khi mở file JS/TS.
    assert.equal(lens.lsp.serverOverrides.typescript.initializationOptions.disableAutomaticTypingAcquisition, true);
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

test("model-roles: preset và ghi đè đi tới mọi file gốc (settings, file role, advisor, goal, auto mode)", () => {
  const presets = loadPresets(path.join(repoDir, "assets", "configs", "model-presets.json"));
  const { roles } = resolveModelRoles(presets, { preset: "claude", roles: { worker: { thinking: "max" }, oracle: { thinking: "max" } } });
  const root = "/home/dev/pi", agentDir = "/home/dev/agent";
  const files = buildConfiguration({ root, agentDir, binDir: "/home/dev/bin", nodePath: "/opt/node", platform: "linux", home: "/home/dev", repoDir, modelRoles: roles });
  const read = (name) => files.find((entry) => entry.path === path.posix.join(agentDir, name)).content;
  const settings = JSON.parse(read("settings.json"));
  assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["anthropic", "claude-opus-5-5", "high"]);
  assert.deepEqual(settings.enabledModels, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5"]);
  assert.deepEqual(settings.modelThinkingLevels, { "anthropic/claude-opus-5-5": "high", "anthropic/claude-fable-5-1": "high", "anthropic/claude-sonnet-5": "high" });
  assert.deepEqual([settings.autoMode.model, settings.autoMode.stage2Reasoning, settings.autoMode.jev.model], ["anthropic/claude-sonnet-5", "low", "jev-1.13.0"]);
  const frontmatter = (role) => read(`agents/${role}.md`).split("\n---\n")[0];
  assert.match(frontmatter("worker"), /^model: anthropic\/claude-opus-5-5\nthinking: max$/mu);
  assert.match(frontmatter("reviewer"), /^model: anthropic\/claude-fable-5-1\nthinking: high$/mu);
  assert.match(frontmatter("researcher"), /^model: anthropic\/claude-sonnet-5\nthinking: high$/mu);
  const advisor = JSON.parse(read("advisor.json"));
  assert.deepEqual([advisor.executor, advisor.executorEffort, advisor.advisor, advisor.advisorEffort, advisor.alwaysOn],
    ["anthropic/claude-opus-5-5", "high", "anthropic/claude-fable-5-1", "high", true]);
  // pi-goal-x chỉ nhận tới xhigh.
  const goal = JSON.parse(read("pi-goal-x-settings.json"));
  assert.deepEqual([goal.provider, goal.model, goal.thinkingLevel, goal.maxAutonomousRuns], ["anthropic", "claude-sonnet-5", "high", 10]);
  assert.deepEqual(goal.oracle, { enabled: true, provider: "anthropic", model: "claude-fable-5-1", thinkingLevel: "xhigh" });
  // Hướng dẫn cho parent nêu đúng model/thinking của từng vai.
  const guide = read("AGENTS.md");
  assert.match(guide, /researcher dùng claude-sonnet-5\/high .*worker dùng claude-opus-5-5\/max; debugger dùng claude-opus-5-5\/high; reviewer dùng claude-fable-5-1\/high/u);
  assert.match(guide, /Parent claude-opus-5-5\/high giữ thiết kế/u);
  assert.match(guide, /Advisor claude-fable-5-1\/high luôn bật/u);
  assert.match(guide, /auditor claude-sonnet-5\/high kiểm tra độc lập/u);
  assert.doesNotMatch(guide, /\{\{/u);
});

test("pi-models dựng mặc định mới từ base của preset khác: giống hệt file installer sinh cho preset đó", () => {
  const presets = loadPresets(path.join(repoDir, "assets", "configs", "model-presets.json"));
  for (const platform of ["linux", "win32"]) {
    const { p, options } = fixture(platform);
    const before = resolveModelRoles(presets).roles;
    const after = resolveModelRoles(presets, { preset: "claude", roles: { worker: { thinking: "max" }, auditor: { thinking: "max" }, autoMode: { model: "anthropic/claude-haiku-4-5" } } }).roles;
    const old = buildConfiguration({ ...options, modelRoles: before });
    const fresh = new Map(buildConfiguration({ ...options, modelRoles: after }).map((entry) => [entry.path, entry.content]));
    const kinds = [];
    for (const entry of old) {
      const kind = nativeKind(entry.path, options.agentDir, p);
      if (!kind) {
        // File không chứa model thì không đổi theo preset (trừ AGENTS.md, sinh lại từ bản mẫu).
        if (p.basename(entry.path) !== "AGENTS.md") assert.equal(fresh.get(entry.path), entry.content, entry.path);
        continue;
      }
      kinds.push(kind);
      assert.equal(nextModelDefault(kind, entry.content, nativeValues(after)), fresh.get(entry.path), entry.path);
    }
    assert.deepEqual(kinds.sort(), ["advisor", "debugger", "goal", "researcher", "reviewer", "settings", "worker"]);
    const template = fs.readFileSync(path.join(repoDir, "assets", "AGENTS.md"), "utf8");
    assert.equal(fillRoleNames(template, after), fresh.get(p.join(options.agentDir, "AGENTS.md")));
    assert.deepEqual(changedRoles(before, after), ["researcher", "worker", "debugger", "reviewer", "advisor", "auditor", "oracle", "autoMode"]);
  }
});

test("ép giá trị của vai trong file gốc người dùng đã đổi: chỉ vai được nêu, bỏ khóa khiến vai dùng giá trị khác", () => {
  const presets = loadPresets(path.join(repoDir, "assets", "configs", "model-presets.json"));
  const models = nativeValues(resolveModelRoles(presets, { preset: "claude" }).roles);
  const settings = JSON.stringify({ theme: "rose-pine-dawn", defaultProvider: "openai-codex", defaultModel: "gpt-6-sol", defaultThinkingLevel: "max",
    enabledModels: ["user/model"], autoMode: { model: "openai-codex/gpt-6-sol", stage2Model: "openai-codex/gpt-6-astra", stage2Reasoning: "high", log: true } });
  const onlyMain = JSON.parse(forceNativeModels("settings", settings, models, ["main"]));
  assert.deepEqual([onlyMain.theme, onlyMain.defaultProvider, onlyMain.defaultModel, onlyMain.defaultThinkingLevel], ["rose-pine-dawn", "anthropic", "claude-opus-5-5", "high"]);
  // Danh sách suy ra (enabledModels) và vai không nêu giữ nguyên; bước gộp ba chiều lo phần đó.
  assert.deepEqual([onlyMain.enabledModels, onlyMain.autoMode.model, onlyMain.autoMode.stage2Model], [["user/model"], "openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra"]);
  const autoMode = JSON.parse(forceNativeModels("settings", settings, models, ["autoMode"])).autoMode;
  assert.deepEqual(autoMode, { model: "anthropic/claude-sonnet-5", stage2Reasoning: "low", log: true });
  assert.equal(forceNativeModels("settings", settings, models, ["worker"]), settings);
  const goal = JSON.stringify({ provider: "openai-codex", model: "gpt-6-astra", thinking_level: "low", maxAutonomousRuns: 3, oracle: { enabled: true, thinking_level: "low" } });
  assert.deepEqual(JSON.parse(forceNativeModels("goal", goal, models, ["auditor", "oracle"])), {
    provider: "anthropic", model: "claude-sonnet-5", maxAutonomousRuns: 3, thinkingLevel: "high",
    oracle: { enabled: true, provider: "anthropic", model: "claude-fable-5-1", thinkingLevel: "high" },
  });
  const advisor = JSON.parse(forceNativeModels("advisor", JSON.stringify({ executor: "anthropic/claude-sonnet-5", executorEffort: "low", advisor: "x/y", alwaysOn: true }), models, ["main"]));
  assert.deepEqual(advisor, { executor: "anthropic/claude-opus-5-5", executorEffort: "high", advisor: "x/y", alwaysOn: true });
  const role = "---\nname: worker\ntools: read\nmodel: openai-codex/gpt-6-sol\n---\n\nPrompt.\n";
  assert.equal(forceNativeModels("worker", role, models, ["worker"]), "---\nname: worker\ntools: read\nmodel: anthropic/claude-opus-5-5\nthinking: high\n---\n\nPrompt.\n");
  assert.equal(forceNativeModels("worker", role, models, ["main"]), role);
  // Không đọc được thì trả nguyên văn: bước gộp giữ file và báo lại.
  for (const [kind, text] of [["settings", "{ hỏng"], ["settings", "[]"], ["worker", "không có frontmatter"]]) assert.equal(forceNativeModels(kind, text, models, ["main", "autoMode", "worker"]), text);
});
