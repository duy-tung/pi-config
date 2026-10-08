import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildConfiguration, CLASSIFIER, PACKAGES } from "../lib/config.mjs";
import { loadModelDefaults } from "../runtime/model-roles.mjs";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
const modelDefaults = loadModelDefaults(repoDir);
function fixture(platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:\\Users\\Dev Example" : "/home/dev example";
  const root = p.join(home, "Pi Runtime");
  const agentDir = p.join(home, "Custom Agent");
  const nodePath = platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/node/bin/node";
  const shellPath = platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  const options = { root, agentDir, nodePath, platform, home, repoDir, shellPath, modelDefaults };
  const files = buildConfiguration(options);
  const read = (file) => {
    const found = files.find((entry) => entry.path === file);
    assert.ok(found, `Thiếu managed file ${file}`);
    return found.content;
  };
  const json = (file) => JSON.parse(read(file));
  const profile = { agentDir, runtime: "current", packages: PACKAGES };
  return { p, options, files, read, json, profile };
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform}: một cấu hình Pi, model, thinking và phạm vi extension`, () => {
    const { p, options, json, profile, read, files } = fixture(platform);
    const name = "main";
    const expected = {
      main: ["current", "anthropic", "claude-opus-5-5", "high", "rose-pine-moon"],
    };
    assert.ok(!files.some((file) => p.basename(file.path) === "profiles.json"));
    {
      const settings = json(p.join(profile.agentDir, "settings.json"));
      assert.deepEqual([profile.runtime, settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel, settings.theme], expected[name]);
      assert.deepEqual(settings.modelThinkingLevels, {
        "anthropic/claude-opus-5-5": "high", "anthropic/claude-fable-5-1": "high", "anthropic/claude-sonnet-5-5": "high",
      });
      assert.equal(settings.shellPath, options.shellPath);
      // Chỉ skill firecrawl gốc (nó dẫn tới các skill firecrawl-* cùng thư mục); pi-config không cài skill quy trình.
      assert.deepEqual(settings.skills, [p.join(options.root, "sources", "firecrawl-cli-source", "skills", "firecrawl")]);
      assert.ok(!settings.skills.some((entry) => entry.includes("mattpocock")));
      assert.deepEqual(settings.extensions, [...["rose-pine-palette.ts", "pi-rewind", "claude-usage", "pi-auto-mode"]
        .map((entry) => p.join(options.root, "assets", "extensions", entry)), "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]);
      assert.equal(settings.doubleEscapeAction, "none");
      assert.deepEqual(settings.rewind, { storageDir: p.join(options.root, "state", "rewind") }, "retentionDays theo mặc định 30 ngày của pi-rewind");
      assert.equal(settings.workspaceHistory, undefined);
      const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, "manifests", "current", "package.json"), "utf8"));
      assert.equal(settings.lastChangelogVersion, manifest.dependencies["@earendil-works/pi-coding-agent"]);
      assert.ok(settings.packages.every((entry) => (typeof entry === "string" ? entry : entry.source).startsWith(p.join(options.root, "runtimes", profile.runtime, "node_modules"))));
      const providers = json(p.join(profile.agentDir, "models.json")).providers;
      assert.deepEqual(Object.keys(providers), ["openai-codex"], "Opus 5.5 và openai (Sign in with ChatGPT) dùng context của catalog");
      assert.deepEqual(providers["openai-codex"].modelOverrides, { "gpt-6-sol": { contextWindow: 872000 }, "gpt-6.1-sol": { contextWindow: 872000 }, "gpt-6-astra": { contextWindow: 872000 } });
      assert.deepEqual(settings.enabledModels, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5-5"]);
      if (name === "main") {
      const roles = {
        researcher: ["anthropic/claude-sonnet-5-5", "high"], worker: ["anthropic/claude-opus-5-5", "high"],
        reviewer: ["anthropic/claude-fable-5-1", "high"],
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
        // Worker ghi file: chạy foreground. Worker và reviewer nạp pi-usage để request fast có chi phí đúng
        // khi người dùng đổi vai đó sang model Codex.
        const foreground = role === "worker";
        assert.equal(field("run_in_background"), foreground ? "false" : undefined, role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-usage"), role !== "researcher", role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-web-access"), role === "researcher", role);
      }
      const subagents = json(p.join(profile.agentDir, "subagents.json"));
      assert.deepEqual([subagents.maxConcurrent, subagents.maxConcurrentForeground], [4, 2]);
      // Model của vai ghim trong file role, đổi bằng /agents; không giới hạn theo enabledModels (Ctrl+P của phiên chính).
      assert.equal(subagents.scopeModels, undefined);
      // Mặc định của pi-subagents: không giới hạn lượt, chạy nền, nhớ agent giữa các lần gọi.
      assert.deepEqual([subagents.defaultMaxTurns, subagents.backgroundByDefault, subagents.rememberAgents], [undefined, undefined, undefined]);
      assert.equal(files.filter(file=>file.path.startsWith(p.join(profile.agentDir,"agents")+p.sep)).length,3);
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

  test(`${platform}: không cài sẵn MCP, đường dẫn có khoảng trắng và credential được chặn`, () => {
    const { p, options, json, profile, files } = fixture(platform);
    const forward = (value) => value.replaceAll("\\", "/");
    {
      assert.ok(!files.some((file) => /^mcp(?:-adapter)?\.json$/u.test(p.basename(file.path))), "không cài sẵn server MCP");
      const settings = json(p.join(profile.agentDir, "settings.json"));
      const deny = settings.permissions.deny;
      for (const file of [p.join(options.agentDir, "auth.json"), p.join(options.root, "secrets", "*.env"), p.join(options.home, ".codex", "auth.json")]) {
        assert.ok(deny.includes(`Path(${forward(file)})`), file);
      }
      assert.ok(deny.includes("Bash(*firecrawl-key.cjs*)"));
      assert.ok(deny.includes("!Path(*.env.example)"));
      // Xoá đệ quy do pi-auto-mode hỏi (bypass) hoặc phân loại (auto), không chặn cứng theo một cách viết cờ.
      assert.ok(!deny.some((rule) => rule.startsWith("Bash(rm ")));
      assert.equal(settings.permissions.defaultMode, "auto");
      assert.equal(settings.autoMode.model, "anthropic/claude-sonnet-5-5");
      // Giai đoạn 1 là Jev khi có key, model ghim phiên bản (ngưỡng trong code, chỉnh theo phiên bản).
      assert.deepEqual(settings.autoMode.jev, { model: "jev-1.13.0" });
      assert.ok(settings.extensions.filter((entry) => !entry.startsWith("-")).at(-1).endsWith("pi-auto-mode"), "pi-auto-mode phải nạp sau cùng");
      assert.ok(!settings.packages.some((entry) => String(entry?.source ?? entry).includes("pi-permission-system")));
      assert.ok(!files.some((file) => file.path.includes("pi-permission-system")));
      assert.deepEqual(json(p.join(profile.agentDir, "keybindings.json"))["app.thinking.cycle"], ["alt+t"]);
      assert.deepEqual(json(p.join(profile.agentDir, "keybindings.json"))["tui.altScreen.search"], ["alt+s"]);
      // Follow-up giữ phím mặc định của Pi.
      assert.equal(json(p.join(profile.agentDir, "keybindings.json"))["app.message.followUp"], undefined);
      const firecrawl = json(p.join(profile.agentDir, "web-search.json"));
      // provider cố định sẽ bỏ qua searchRouting; native search theo model (Codex, Claude) đi trước, Firecrawl dự phòng.
      assert.equal(firecrawl.provider, undefined);
      assert.deepEqual(firecrawl.searchRouting.providers, ["openai", "anthropic", "exa", "firecrawl"]);
      assert.equal(firecrawl.searchRouting.useCurrentModel, true);
      assert.deepEqual(firecrawl.searchRouting.fallbackOn, ["network", "transient", "quota", "invalid-response", "unsupported"]);
      assert.deepEqual(firecrawl.webSearch.allowedProviders, ["openai", "anthropic", "exa", "firecrawl"]);
      assert.equal(firecrawl.anthropicSearch, undefined, "Model khác Claude không tìm bằng Claude nếu người dùng không bật");
      assert.equal(firecrawl.exaApiKey, undefined, "Exa không cần key: dùng endpoint MCP miễn phí");
      assert.deepEqual(settings.permissions.ask, []);
      assert.deepEqual(firecrawl.fetchRouting.providers, ["firecrawl"]);
      assert.ok(settings.permissions.allow.includes("web_search"));
      assert.equal(firecrawl.allowBrowserCookies, undefined, "pi-web-access chỉ đọc cookie trình duyệt khi bật rõ (true)");
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

  test(`${platform}: không xuất credential; advisor đúng cấu hình đã chọn`, () => {
    const { p, options, files, json, profile } = fixture(platform);
    assert.equal(new Set(files.map(({ path: file }) => file)).size, files.length);
    for (const file of files) {
      assert.notEqual(p.basename(file.path), "auth.json");
      assert.doesNotMatch(file.path, /sessions|mcp-cache|models-store/u);
      assert.doesNotMatch(file.content, /\/Users\/tung|apikey_[a-z0-9]|fc-[a-f0-9]{20}|[A-Z_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)=/u);
    }
    {
      if (profile.packages.includes("pi-advisor-flow")) {
      const advisor = json(p.join(profile.agentDir, "advisor.json"));
      const settings = json(p.join(profile.agentDir, "settings.json"));
      // Luôn bật với executor là chính model mặc định (Opus/high), nên mở phiên không đổi model.
      assert.equal(advisor.alwaysOn, true);
      assert.equal(advisor.executor, `${settings.defaultProvider}/${settings.defaultModel}`);
      // Không có executorEffort: thinking của phiên chính theo settings.json (/model, /thinking của Pi).
      assert.equal(advisor.executorEffort, undefined);
      assert.equal(advisor.advisor, "anthropic/claude-fable-5-1");
      assert.equal(advisor.advisorEffort, "high");
      // Khi request tới advisor lỗi, thử lại một lần với Opus (cùng advisorEffort). Fallback trùng model của phiên chính,
      // nên phải tắt chặn advisor trùng model; mặc định đặt advisor khác main nên lượt gọi chính không đổi.
      assert.equal(advisor.advisorFallbackModel, "anthropic/claude-opus-5-5");
      assert.equal(advisor.advisorDisableSameModel, false);
      // Gate là hướng dẫn trong prompt: khi lỗi lặp lại và trước khi báo xong; không có gate cứng chặn phiên. Người dùng
      // đổi gate và số lượt bằng /advisor-settings; cài lại giữ giá trị đó (gộp ba chiều).
      assert.deepEqual([advisor.advisorPlanGate, advisor.advisorFailureGate, advisor.advisorCompletionGate], [false, true, true]);
      assert.equal(advisor.advisorAutoLoopGate, false);
      assert.equal(advisor.gateFailureMode, "warn-and-continue");
      assert.equal(advisor.advisorMaxCallsPerSession, undefined, "không giới hạn số lần gọi mỗi phiên");
      // Diff đầy đủ chiếm tối đa một nửa contextMaxChars: 20.000 ký tự diff, còn ít nhất 40.000 cho hội thoại.
      assert.equal(advisor.advisorGitContext, "full");
      assert.equal(advisor.advisorGitContextMaxChars, undefined, "mặc định 20.000 của pi-advisor-flow");
      assert.ok(advisor.contextMaxChars >= 2 * 20000);
      assert.equal(advisor.advisorRedactSecrets, true);
      assert.equal(advisor.advisorTrackedFileContent, false);
      assert.equal(advisor.advisorUntrackedContent, false);
      // Advisor đã có hội thoại; không gửi thêm AGENTS.md (mặc định bật từ 0.10.0) để request advisor nhỏ hơn.
      assert.equal(advisor.advisorAgentsMdContext, false);
      } else assert.ok(!files.some(file => file.path === p.join(profile.agentDir,"advisor.json")));
      assert.ok(!files.some(file => /goal/u.test(p.basename(file.path))), "pi-goal-x đã gỡ");
      assert.equal(json(p.join(profile.agentDir, "settings.json")).cacheWarming, "off");
      if (profile.packages.includes("@tintinweb/pi-subagents")) assert.equal(json(p.join(profile.agentDir, "subagents.json")).fallbackSubagent, "none");
      else assert.ok(!files.some(file => file.path === p.join(profile.agentDir,"subagents.json")));
    }
  });
}

test("POSIX credential helper chạy đúng khi root chứa khoảng trắng, nháy đơn và shell metacharacters", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-quote-"));
  try {
    const root = path.join(dir, "Dev's runtime $(touch SHOULD_NOT_EXIST)");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "firecrawl-key.cjs"), 'process.stdout.write("fixture-credential");\n');
    const agentDir = path.join(dir, "Agent");
    const generated = buildConfiguration({ root, agentDir, nodePath: process.execPath, platform: "linux", home: dir, repoDir, modelDefaults });
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
    const generated = buildConfiguration({ root, agentDir, nodePath: process.execPath, platform: "win32", home: dir, repoDir, modelDefaults });
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

test("model mặc định đi tới mọi file gốc (settings, file role, advisor); model phân loại không phải một vai", () => {
  const root = "/home/dev/pi", agentDir = "/home/dev/agent";
  const files = buildConfiguration({ root, agentDir, nodePath: "/opt/node", platform: "linux", home: "/home/dev", repoDir, modelDefaults });
  const read = (name) => files.find((entry) => entry.path === path.posix.join(agentDir, name)).content;
  const settings = JSON.parse(read("settings.json"));
  assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["anthropic", "claude-opus-5-5", "high"]);
  assert.deepEqual(settings.enabledModels, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5-5"]);
  assert.deepEqual(CLASSIFIER, { model: "anthropic/claude-sonnet-5-5", stage2Reasoning: "low" });
  assert.deepEqual([settings.autoMode.model, settings.autoMode.stage2Reasoning, settings.autoMode.jev.model], ["anthropic/claude-sonnet-5-5", "low", "jev-1.13.0"]);
  const frontmatter = (role) => read(`agents/${role}.md`).split("\n---\n")[0];
  assert.match(frontmatter("worker"), /^model: anthropic\/claude-opus-5-5\nthinking: high$/mu);
  assert.match(frontmatter("reviewer"), /^model: anthropic\/claude-fable-5-1\nthinking: high$/mu);
  assert.match(frontmatter("researcher"), /^model: anthropic\/claude-sonnet-5-5\nthinking: high$/mu);
  // Model của từng vai đổi thẳng trong file gốc (/model, /agents, /advisor-models): không còn lớp cấu hình hay lệnh riêng.
  assert.ok(!files.some((entry) => /model-roles/u.test(entry.path)));
  assert.ok(!settings.extensions.some((entry) => entry.endsWith("model-roles")));
  const advisor = JSON.parse(read("advisor.json"));
  assert.deepEqual([advisor.executor, advisor.advisor, advisor.advisorEffort, advisor.alwaysOn],
    ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "high", true]);
  assert.ok(!Object.hasOwn(advisor, "executorEffort"), "advisor không đặt lại thinking của phiên chính");
});
