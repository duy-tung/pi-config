import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBAGENT_ROLES, fillRoleNames, loadPresets, nativeValues, resolveModelRoles, setRoleModel } from "../runtime/model-roles.mjs";

const sourceAssets = fileURLToPath(new URL("../assets/", import.meta.url));
const sourceManifests = fileURLToPath(new URL("../manifests/", import.meta.url));

const common = [
  "@gotgenes/pi-anthropic-auth",
  "@juicesharp/rpiv-ask-user-question",
  "@juicesharp/rpiv-todo",
  "pi-mcp-adapter",
  "pi-web-access",
  "@narumitw/pi-usage",
];
const uiPackages = ["pi-open-tui", "@pi-archimedes/image-paste"];
const definitions = {
  main: {
    runtime: "current", theme: "rose-pine-moon", packages: [...common, "@tintinweb/pi-subagents", "pi-lens", "pi-goal-x", "pi-background-tasks", "pi-advisor-flow", ...uiPackages],
  },
};

// Credential commands run under /bin/sh or cmd.exe in pi-web-access.
// Quotes are code, never JSON string escaping. Reject cmd expansion characters
// which cannot be represented safely by a simple quoted command argument.
function shellQuote(value, platform) {
  if (/[\0\r\n]/u.test(value)) throw new Error("Đường dẫn không được chứa NUL hoặc xuống dòng.");
  if (platform === "win32") {
    if (/["%!]/u.test(value)) throw new Error("Đường dẫn Windows dùng cho credential helper không được chứa dấu nháy kép, % hoặc !.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Return managed file specifications only; never read auth, logs or sessions.
 * Installer owns conflict detection, backups, atomic writes and asset copying.
 * Paths are native for the target platform; permission globs use forward slashes.
 * modelRoles: model/thinking đã resolve của từng vai (runtime/model-roles.mjs); mặc định là preset "default".
 */
export function buildConfiguration({ root, agentDir, binDir, nodePath, platform = process.platform, home, repoDir, shellPath, modelRoles }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const [name, value] of Object.entries({ root, agentDir, binDir, nodePath, home })) {
    if (typeof value !== "string" || !paths.isAbsolute(value)) {
      throw new Error(`${name} phải là đường dẫn tuyệt đối của ${platform}.`);
    }
  }
  const assets = repoDir ? path.join(repoDir, "assets") : sourceAssets;
  const readText = (name) => fs.readFileSync(path.join(assets, name), "utf8");
  const readJson = (name) => JSON.parse(readText(`configs/${name}.json`));
  const roles = modelRoles ?? resolveModelRoles(loadPresets(path.join(assets, "configs", "model-presets.json"))).roles;
  const models = nativeValues(roles);
  const manifests = repoDir ? path.join(repoDir, "manifests") : sourceManifests;
  const piVersion = JSON.parse(fs.readFileSync(path.join(manifests, "current", "package.json"), "utf8"))
    .dependencies["@earendil-works/pi-coding-agent"];
  const targetAssets = paths.join(root, "assets");
  const join = (...parts) => paths.join(...parts);
  const glob = (value) => value.replaceAll("\\", "/");
  const profiles = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {
    runtime: definition.runtime,
    agentDir: name === "main" ? agentDir : join(root, "profiles", name),
    packages: [...definition.packages],
  }]));
  const result = [];
  const addText = (file, content, mode = 0o600) => result.push({ path: file, content, mode });
  const addJson = (file, value) => addText(file, `${JSON.stringify(value, null, 2)}\n`);
  const helperCommand = `!${shellQuote(nodePath, platform)} ${shellQuote(join(root, "bin", "firecrawl-key.cjs"), platform)}`;
  const skills = [
    join(root, "sources", "mattpocock-skills", "skills", "engineering"),
    join(root, "sources", "firecrawl-cli-source", "skills"),
    join(root, "sources", "firecrawl-workflows", "skills"),
  ];
  // Upstream Firecrawl CLI 1.24.4 derives these paths from os.homedir().
  const firecrawlCredentials = platform === "darwin"
    ? join(home, "Library", "Application Support", "firecrawl-cli")
    : platform === "win32"
      ? join(home, "AppData", "Roaming", "firecrawl-cli")
      : join(home, ".config", "firecrawl-cli");
  // Thư mục chỉ chứa bí mật: chặn mọi cấp bên trong (vd ~/.aws/sso/cache) và chính thư mục,
  // để lệnh đọc cả thư mục (tar, cp -r, grep -r ~/.ssh) không lọt qua luật theo từng file.
  const secretDirs = [
    join(home, ".ssh"), join(home, ".aws"), join(home, ".config", "gcloud"), firecrawlCredentials,
    join(root, "backups"), join(home, ".local", "share", "pi-retired"),
  ];
  const protectedPaths = [
    ...secretDirs.flatMap((dir) => [dir, join(dir, "**")]),
    join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(agentDir, "auth.json"), join(root, "profiles", "*", "auth.json"),
    join(root, "secrets", "*.env"),
  ];
  // pi-auto-mode: luật deny áp dụng ở cả auto và bypass (như permissions.deny của Claude Code).
  // Path(...) = đọc và ghi; "!" là ngoại lệ. Mọi thứ khác do bộ phân loại của auto mode quyết định.
  const permissions = {
    defaultMode: "auto",
    allow: [
      "web_search", "WebFetch(domain:github.com)", "WebFetch(domain:raw.githubusercontent.com)",
      "WebFetch(domain:docs.claude.com)", "WebFetch(domain:code.claude.com)",
    ],
    // pi-goal-x cho agent tự sửa maxAutonomousRuns trong file project này; file đó đè giới hạn global.
    ask: ["Edit(**/.pi/pi-goal-x-settings.json)"],
    deny: [
      "Path(*.env)", "Path(*.env.*)", "!Path(*.env.example)",
      ...protectedPaths.map((entry) => `Path(${glob(entry)})`),
      "Path(**/credentials.json)",
      // Token và khóa phổ biến (cùng danh sách deny đọc trong Claude Code của người dùng).
      "Path(~/.gnupg)", "Path(~/.gnupg/**)", "Path(~/.kube/config)", "Path(~/.netrc)", "Path(~/.git-credentials)",
      "Path(~/.config/gh/hosts.yml)", "Path(~/.docker/config.json)", "Path(**/id_rsa*)", "Path(**/id_ed25519*)", "Path(**/*.pem)",
      // Xoá đệ quy không nằm ở đây: pi-auto-mode nhận ra mọi dạng (rm -fr, find -delete, git clean...),
      // bypass hỏi người dùng, auto gửi bộ phân loại.
      "Bash(sudo *)", "Bash(*firecrawl-key.cjs*)", "Bash(*pi-mcp-adapter.service-key*)",
      "mcpScript",
    ],
  };
  // Giai đoạn 1 là Jev (System One của TypeSafe) khi có API key; không có thì model LLM làm cả hai giai đoạn
  // (cùng model để giai đoạn 2 dùng lại cache của giai đoạn 1). Ngưỡng chỉnh theo phiên bản Jev đã ghim.
  // Model LLM là Sonnet 5 như bộ phân loại của Claude Code (eval 9/2026: 0/27 lọt, 0/22 chặn nhầm).
  const autoMode = {
    ...models.autoMode,
    jev: { model: "jev-1.13.0", flagAt: 0.3, riskAt: 0.5, probe: true },
  };
  for (const [name, profile] of Object.entries(profiles)) {
    const definition = definitions[name];
    const dir = profile.agentDir;
    const hasAgents = profile.packages.includes("@tintinweb/pi-subagents");
    const settings = {
      defaultProvider: models.settings.defaultProvider, defaultModel: models.settings.defaultModel,
      defaultThinkingLevel: models.settings.defaultThinkingLevel, modelThinkingLevels: models.settings.modelThinkingLevels,
      defaultProjectTrust: "ask", packages: profile.packages.map((pkg) => {
        const source = join(root, "runtimes", profile.runtime, "node_modules", pkg);
        // 2.6.x khai báo extension đã build trong dist/; chỉ nạp phần shell jobs.
        return pkg === "pi-background-tasks" ? { source, extensions: ["dist/extensions/background-tasks.js"] } : source;
      }),
      skills, warnings: { anthropicExtraUsage: true },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, cacheWarming: "off",
      theme: definition.theme,
      // pi-auto-mode nạp sau cùng để duyệt input cuối của mỗi tool call (handler trước có thể sửa input).
      extensions: ["rose-pine-palette.ts", "pi-rewind", "claude-usage", "model-roles", "pi-auto-mode"]
        .map((entry) => join(targetAssets, "extensions", entry)),
      themes: [join(targetAssets, "themes")], quietStartup: true, showHardwareCursor: true,
    };
    if (shellPath) settings.shellPath = shellPath;
    settings.enabledModels = models.settings.enabledModels;
    // Pi ghi lastChangelogVersion khi gặp phiên bản mới; ghi sẵn bản đã ghim để settings.json
    // không bị coi là file người dùng sửa ở lần cài/nâng cấp sau.
    settings.lastChangelogVersion = piVersion;
    // Esc Esc mở /rewind của pi-rewind thay cho /tree; /tree vẫn dùng bằng lệnh.
    settings.doubleEscapeAction = "none";
    settings.rewind = { storageDir: join(root, "state", "rewind"), retentionDays: 30 };
    settings.permissions = permissions;
    settings.autoMode = { ...autoMode, stateDir: join(root, "state", "auto-mode") };
    addJson(join(dir, "settings.json"), settings);
    // Shift+Tab đổi permission mode như Claude Code; mức thinking chuyển sang Alt+T (Option+T của Claude Code).
    addJson(join(dir, "keybindings.json"), { "app.clipboard.pasteImage": [], "app.thinking.cycle": ["alt+t"] });
    // Opus 5.5 dùng context 1M của catalog; Codex nâng từ 272K.
    const modelOverrides = { "gpt-6-sol": { contextWindow: 872000 }, "gpt-6-astra": { contextWindow: 872000 } };
    const providerModels = { modelOverrides };
    addJson(join(dir, "models.json"), { providers: { "openai-codex": providerModels } });
    // allowInstall=false (pi-mcp-adapter 2.37): agent không tự thêm server vào file installer quản lý.
    addJson(join(dir, "mcp.json"), {
      settings: { hostConfigDiscovery: "off", allowInstall: false },
      mcpServers: { workspace: {
        command: nodePath, args: [join(root, "bin", "workspace-mcp.mjs")],
        cwd: "${PI_WORKSPACE_DIR}", inheritEnv: false, lifecycle: "lazy",
        includeTools: ["read_text_file", "list_directory", "get_file_info", "list_allowed_directories"],
      } },
    });
    // Native search theo model hiện tại: "openai" + useCurrentModel dùng hosted web_search của Codex/OpenAI,
    // "anthropic" (provider do bản vá pi-web-access thêm) dùng web search của Claude; mỗi bước chỉ chạy khi model
    // hiện tại thuộc provider đó. Model khác (GLM) và lỗi tạm thời đi tiếp sang Exa (không có key thì dùng
    // endpoint MCP miễn phí của Exa), rồi Firecrawl. Không đặt "provider" vì provider cố định sẽ bỏ qua searchRouting.
    addJson(join(dir, "web-search.json"), {
      workflow: "none", allowBrowserCookies: false,
      webSearch: { allowedProviders: ["openai", "anthropic", "exa", "firecrawl"] },
      searchRouting: {
        providers: ["openai", "anthropic", "exa", "firecrawl"], useCurrentModel: true,
        fallbackOn: ["network", "transient", "quota", "invalid-response", "unsupported"],
      },
      fetchRouting: { providers: ["firecrawl"], allowRemoteHostedProviders: true }, githubClone: { enabled: false },
      firecrawlBaseUrl: "https://api.firecrawl.dev", firecrawlApiKey: helperCommand,
      firecrawlApiVersion: "v2", firecrawlFreshScrape: true,
    });
    addJson(join(dir, "open-tui.json"), readJson("open-tui"));
    if (hasAgents) addJson(join(dir, "subagents.json"), readJson("subagents"));
    addJson(join(dir, "advisor.json"), { ...models.advisor, ...readJson("advisor") });
    const goal = readJson("goal");
    addJson(join(dir, "pi-goal-x-settings.json"), { ...goal, ...models.goal, oracle: { ...goal.oracle, ...models.goal.oracle } });
    if (name === "main") addJson(join(dir, "pi-usage.json"), { codexFastMode: true });
    addText(join(dir, "AGENTS.md"), fillRoleNames(readText("AGENTS.md"), roles));
    if (hasAgents) for (const role of SUBAGENT_ROLES) addText(join(dir, "agents", `${role}.md`), setRoleModel(readText(`roles/${role}.md`), models.subagents[role]));
  }
  addJson(join(root, "profiles.json"), profiles);
  addJson(join(root, "config", "pi-lens.json"), readJson("lens"));
  return result;
}
