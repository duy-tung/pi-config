import assert from "node:assert/strict";
import fs from "node:fs";
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
  const shellPath = platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  const options = { root, agentDir, platform, home, repoDir, shellPath, modelDefaults };
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
      // pi-config không cài skill nào: skill quy trình và skill của công cụ đều do người dùng tự thêm.
      assert.deepEqual(settings.skills, []);
      assert.deepEqual(settings.extensions, [...["rose-pine-palette.ts", "pi-rewind", "claude-usage", "pi-auto-mode"]
        .map((entry) => p.join(options.root, "assets", "extensions", entry)), "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]);
      assert.equal(settings.doubleEscapeAction, "none");
      assert.deepEqual(settings.rewind, { storageDir: p.join(options.root, "state", "rewind") }, "retentionDays theo mặc định 30 ngày của pi-rewind");
      assert.equal(settings.workspaceHistory, undefined);
      const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, "manifests", "current", "package.json"), "utf8"));
      assert.equal(settings.lastChangelogVersion, manifest.dependencies["@earendil-works/pi-coding-agent"]);
      assert.ok(settings.packages.every((entry) => (typeof entry === "string" ? entry : entry.source).startsWith(p.join(options.root, "runtimes", profile.runtime, "node_modules"))));
      // Mọi model dùng context của catalog Pi; openai-codex (legacy) không còn override 872K. Message threads theo mặc định của Pi.
      assert.ok(!files.some((file) => file.path === p.join(profile.agentDir, "models.json")));
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
        // Worker ghi file: chạy foreground.
        const foreground = role === "worker";
        assert.equal(field("run_in_background"), foreground ? "false" : undefined, role);
        assert.equal(JSON.parse(field("extensions")).includes("pi-usage"), false, role);
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
    // pi-usage đã gỡ: không còn /fast và pi-usage.json.
    assert.ok(!files.some((file) => file.path === p.join(options.agentDir, "pi-usage.json")));
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
      assert.ok(deny.includes("!Path(*.env.example)"));
      // Xoá đệ quy do pi-auto-mode hỏi (bypass) hoặc phân loại (auto), không chặn cứng theo một cách viết cờ.
      assert.ok(!deny.some((rule) => rule.startsWith("Bash(rm ")));
      assert.equal(settings.permissions.defaultMode, "auto");
      assert.equal(settings.autoMode.model, "anthropic/claude-sonnet-5-5");
      // Bộ phân loại LLM cho cả hai giai đoạn; không còn Jev.
      assert.equal(settings.autoMode.jev, undefined);
      assert.ok(settings.extensions.filter((entry) => !entry.startsWith("-")).at(-1).endsWith("pi-auto-mode"), "pi-auto-mode phải nạp sau cùng");
      assert.ok(!settings.packages.some((entry) => String(entry?.source ?? entry).includes("pi-permission-system")));
      assert.ok(!files.some((file) => file.path.includes("pi-permission-system")));
      assert.deepEqual(json(p.join(profile.agentDir, "keybindings.json"))["app.thinking.cycle"], ["alt+t"]);
      assert.deepEqual(json(p.join(profile.agentDir, "keybindings.json"))["tui.altScreen.search"], ["alt+s"]);
      // Follow-up giữ phím mặc định của Pi.
      assert.equal(json(p.join(profile.agentDir, "keybindings.json"))["app.message.followUp"], undefined);
      const web = json(p.join(profile.agentDir, "web-search.json"));
      // provider cố định sẽ bỏ qua searchRouting; native search theo model (Codex, Claude) đi trước, Exa dự phòng.
      assert.equal(web.provider, undefined);
      assert.deepEqual(web.searchRouting.providers, ["openai", "anthropic", "exa"]);
      assert.equal(web.searchRouting.useCurrentModel, true);
      assert.deepEqual(web.searchRouting.fallbackOn, ["network", "transient", "quota", "invalid-response", "unsupported"]);
      assert.deepEqual(web.webSearch.allowedProviders, ["openai", "anthropic", "exa"]);
      assert.equal(web.anthropicSearch, undefined, "Model khác Claude không tìm bằng Claude nếu người dùng không bật");
      assert.equal(web.exaApiKey, undefined, "Exa không cần key: dùng endpoint MCP miễn phí");
      assert.deepEqual(settings.permissions.ask, []);
      // fetch_content theo mặc định của pi-web-access: tải thẳng trang đích, không qua dịch vụ trích xuất bên thứ ba.
      assert.equal(web.fetchRouting, undefined);
      assert.ok(settings.permissions.allow.includes("web_search"));
      assert.equal(web.allowBrowserCookies, undefined, "pi-web-access chỉ đọc cookie trình duyệt khi bật rõ (true)");
      // Không còn gì của Firecrawl trong cấu hình sinh ra: file, key, provider, skill, luật deny.
      for (const file of files) assert.doesNotMatch(`${file.path}\n${file.content}`, /firecrawl/iu, file.path);
      // Thư mục bí mật: chặn cả chính thư mục (tar/cp -r/grep -r) và mọi cấp bên trong (vd ~/.aws/sso/cache).
      for (const dir of [p.join(options.home, ".ssh"), p.join(options.home, ".aws"), p.join(options.home, ".config", "gcloud"), p.join(options.root, "backups")]) {
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
      // Luôn bật, không ghim executor: model và thinking của phiên chính theo settings.json (/model, /thinking của Pi).
      assert.equal(advisor.alwaysOn, true);
      assert.equal(settings.defaultModel, "claude-opus-5-5");
      assert.equal(advisor.executor, undefined);
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

test("Đầu vào tương đối bị từ chối để không ghi nhầm workspace", () => {
  const { options } = fixture("linux");
  assert.throws(() => buildConfiguration({ ...options, agentDir: ".pi/agent" }), /agentDir phải là đường dẫn tuyệt đối/u);
});

test("model mặc định đi tới mọi file gốc (settings, file role, advisor); model phân loại không phải một vai", () => {
  const root = "/home/dev/pi", agentDir = "/home/dev/agent";
  const files = buildConfiguration({ root, agentDir, platform: "linux", home: "/home/dev", repoDir, modelDefaults });
  const read = (name) => files.find((entry) => entry.path === path.posix.join(agentDir, name)).content;
  const settings = JSON.parse(read("settings.json"));
  assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["anthropic", "claude-opus-5-5", "high"]);
  assert.deepEqual(settings.enabledModels, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5-5"]);
  assert.deepEqual(CLASSIFIER, { model: "anthropic/claude-sonnet-5-5", stage2Reasoning: "low" });
  assert.deepEqual([settings.autoMode.model, settings.autoMode.stage2Reasoning, settings.autoMode.jev], ["anthropic/claude-sonnet-5-5", "low", undefined]);
  const frontmatter = (role) => read(`agents/${role}.md`).split("\n---\n")[0];
  assert.match(frontmatter("worker"), /^model: anthropic\/claude-opus-5-5\nthinking: high$/mu);
  assert.match(frontmatter("reviewer"), /^model: anthropic\/claude-fable-5-1\nthinking: high$/mu);
  assert.match(frontmatter("researcher"), /^model: anthropic\/claude-sonnet-5-5\nthinking: high$/mu);
  // Model của từng vai đổi thẳng trong file gốc (/model, /agents, /advisor-models): không còn lớp cấu hình hay lệnh riêng.
  assert.ok(!files.some((entry) => /model-roles/u.test(entry.path)));
  assert.ok(!settings.extensions.some((entry) => entry.endsWith("model-roles")));
  const advisor = JSON.parse(read("advisor.json"));
  assert.deepEqual([advisor.advisor, advisor.advisorEffort, advisor.alwaysOn], ["anthropic/claude-fable-5-1", "high", true]);
  assert.ok(!Object.hasOwn(advisor, "executor") && !Object.hasOwn(advisor, "executorEffort"), "advisor theo model và thinking của phiên chính");
});
