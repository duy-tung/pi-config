import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBAGENT_ROLES, nativeValues, setRoleModel } from "../runtime/model-roles.mjs";

const common = [
  "@gotgenes/pi-anthropic-auth",
  "@juicesharp/rpiv-ask-user-question",
  "@juicesharp/rpiv-todo",
  "pi-web-access",
];
const uiPackages = ["pi-open-tui", "@pi-archimedes/image-paste"];
/**
 * Model LLM mặc định của bộ phân loại auto mode và mức suy luận của giai đoạn 2 (autoMode trong settings.json):
 * Sonnet như bộ phân loại của Claude Code (eval 9/2026 với Sonnet 5: 0/27 lọt, 0/22 chặn nhầm). Người dùng đổi trong
 * /permissions → Classifier; cài lại giữ giá trị đã đổi (gộp ba chiều settings.json). Không phải một vai.
 */
export const CLASSIFIER = { model: "anthropic/claude-sonnet-5-5", stage2Reasoning: "low" };

/** Package Pi nạp, theo thứ tự trong settings.json; tất cả nằm trong runtimes/current. */
export const PACKAGES = [...common, "@tintinweb/pi-subagents", "pi-background-tasks", "pi-advisor-flow", ...uiPackages];
/**
 * Package có skill đi kèm mà pi-config không nạp (pi-config không cài skill nào): `workflow-authoring` của
 * pi-subagents từ 0.26.0 (workflow đang tắt) và `pi-advisor-flow` của pi-advisor-flow từ 0.16.0.
 */
const WITHOUT_BUNDLED_SKILLS = new Set(["@tintinweb/pi-subagents", "pi-advisor-flow"]);

/**
 * Return managed file specifications only; never read auth, logs or sessions.
 * Installer owns conflict detection, backups, atomic writes and asset copying.
 * Paths are native for the target platform; permission globs use forward slashes.
 * modelDefaults: model/thinking mặc định của từng vai (assets/configs/model-defaults.json, runtime/model-roles.mjs).
 */
export function buildConfiguration({ root, agentDir, platform = process.platform, home, repoDir = fileURLToPath(new URL("../", import.meta.url)), shellPath, modelDefaults }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const [name, value] of Object.entries({ root, agentDir, home })) {
    if (typeof value !== "string" || !paths.isAbsolute(value)) {
      throw new Error(`${name} phải là đường dẫn tuyệt đối của ${platform}.`);
    }
  }
  const assets = path.join(repoDir, "assets");
  const readText = (name) => fs.readFileSync(path.join(assets, name), "utf8");
  const readJson = (name) => JSON.parse(readText(`configs/${name}.json`));
  const models = nativeValues(modelDefaults);
  const manifests = path.join(repoDir, "manifests");
  const piVersion = JSON.parse(fs.readFileSync(path.join(manifests, "current", "package.json"), "utf8"))
    .dependencies["@earendil-works/pi-coding-agent"];
  const targetAssets = paths.join(root, "assets");
  const join = (...parts) => paths.join(...parts);
  const glob = (value) => value.replaceAll("\\", "/");
  const result = [];
  const addText = (file, content) => result.push({ path: file, content });
  const addJson = (file, value) => addText(file, `${JSON.stringify(value, null, 2)}\n`);
  // Thư mục chỉ chứa bí mật: chặn mọi cấp bên trong (vd ~/.aws/sso/cache) và chính thư mục,
  // để lệnh đọc cả thư mục (tar, cp -r, grep -r ~/.ssh) không lọt qua luật theo từng file.
  const secretDirs = [
    join(home, ".ssh"), join(home, ".aws"), join(home, ".config", "gcloud"),
    join(root, "backups"),
  ];
  const protectedPaths = [
    ...secretDirs.flatMap((dir) => [dir, join(dir, "**")]),
    join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(agentDir, "auth.json"),
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
    ask: [],
    deny: [
      "Path(*.env)", "Path(*.env.*)", "!Path(*.env.example)",
      ...protectedPaths.map((entry) => `Path(${glob(entry)})`),
      "Path(**/credentials.json)",
      // Token và khóa phổ biến (cùng danh sách deny đọc trong Claude Code của người dùng).
      "Path(~/.gnupg)", "Path(~/.gnupg/**)", "Path(~/.kube/config)", "Path(~/.netrc)", "Path(~/.git-credentials)",
      "Path(~/.config/gh/hosts.yml)", "Path(~/.docker/config.json)", "Path(**/id_rsa*)", "Path(**/id_ed25519*)", "Path(**/*.pem)",
      // Xoá đệ quy không nằm ở đây: pi-auto-mode nhận ra mọi dạng (rm -fr, find -delete, git clean...),
      // bypass hỏi người dùng, auto gửi bộ phân loại.
      "Bash(sudo *)",
    ],
  };
  const dir = agentDir;
  const settings = {
    defaultProvider: models.settings.defaultProvider, defaultModel: models.settings.defaultModel,
    defaultThinkingLevel: models.settings.defaultThinkingLevel, modelThinkingLevels: models.settings.modelThinkingLevels,
    packages: PACKAGES.map((pkg) => {
      const source = join(root, "runtimes", "current", "node_modules", pkg);
      // 2.6.x khai báo extension đã build trong dist/; chỉ nạp phần shell jobs.
      if (pkg === "pi-background-tasks") return { source, extensions: ["dist/extensions/background-tasks.js"] };
      return WITHOUT_BUNDLED_SKILLS.has(pkg) ? { source, skills: [] } : source;
    }),
    // Giữ ấm prompt cache khi phiên nghỉ (mặc định của Pi từ 1.5.1): Pi gửi lại request cuối với 1 token output trước
    // khi cache 5 phút hết hạn, tối đa 30 phút sau khi agent dừng và chỉ khi ước tính có lợi. Xem docs/claude-setup.md.
    skills: [], cacheWarming: "idle",
    // Tắt cảnh báo extra usage lúc khởi động của Pi: phiên chính, compaction và extension gọi qua ModelRuntime đều
    // đi qua shaping của pi-anthropic-auth. Bật lại trong /settings → Warnings.
    warnings: { anthropicExtraUsage: false },
    theme: "rose-pine-moon",
    // pi-auto-mode nạp sau cùng để duyệt input cuối của mỗi tool call (handler trước có thể sửa input).
    // Pi 0.99 nạp thêm extension dựng sẵn (builtin:*) sau các extension trên. Tắt MCP dựng sẵn: pi-config không dùng
    // server MCP nào; cần thì bật lại trong `pi config` (Built-in) và thêm server vào mcp.json. Tắt codemode và
    // tool_search: lời gọi lồng trong codemode vẫn qua cổng tool_call của pi-auto-mode, nhưng models.classify() của
    // script gửi dữ liệu tới model phân loại mà không qua cổng. Người dùng bật lại trong `pi config` (Built-in).
    extensions: [
      ...["rose-pine-palette.ts", "pi-rewind", "claude-usage", "pi-auto-mode"]
        .map((entry) => join(targetAssets, "extensions", entry)),
      "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp",
    ],
    themes: [join(targetAssets, "themes")], quietStartup: true, showHardwareCursor: true,
  };
  if (shellPath) settings.shellPath = shellPath;
  settings.enabledModels = models.settings.enabledModels;
  // Pi ghi lastChangelogVersion khi gặp phiên bản mới; ghi sẵn bản đã ghim để settings.json
  // không bị coi là file người dùng sửa ở lần cài/nâng cấp sau.
  settings.lastChangelogVersion = piVersion;
  // Esc Esc mở /rewind của pi-rewind thay cho /tree; /tree vẫn dùng bằng lệnh.
  settings.doubleEscapeAction = "none";
  settings.rewind = { storageDir: join(root, "state", "rewind") };
  settings.permissions = permissions;
  // Model LLM làm cả hai giai đoạn (cùng model để giai đoạn 2 dùng lại cache của giai đoạn 1).
  settings.autoMode = { ...CLASSIFIER, stateDir: join(root, "state", "auto-mode") };
  addJson(join(dir, "settings.json"), settings);
  // Shift+Tab đổi mức thinking (mặc định của Pi), Alt+T giữ lại làm phím thứ hai; permission mode đổi trong /permissions.
  // Tìm trong transcript fullscreen chuyển sang Alt+S: WezTerm giữ Ctrl+Shift+F cho ô tìm của nó.
  addJson(join(dir, "keybindings.json"), {
    "app.clipboard.pasteImage": [], "app.thinking.cycle": ["shift+tab", "alt+t"], "tui.altScreen.search": ["alt+s"],
  });
  // Không sinh models.json: mọi model dùng context của catalog Pi (Opus 5.5 1M). Message threads của Pi 1.5.1 để mặc định
  // (bật): đã kiểm với Claude OAuth thật, xem docs/claude-setup.md.
  // Native search theo model hiện tại: "anthropic" (provider do bản vá pi-web-access thêm) + useCurrentModel dùng web
  // search của Claude, chỉ chạy khi model hiện tại là Claude của provider anthropic. Không có provider dự phòng: native
  // search lỗi thì lỗi được báo lại, truy vấn không gửi cho bên thứ ba. Không đặt "provider" vì provider cố định sẽ bỏ
  // qua searchRouting.
  // fetch_content: tải thẳng trang đích rồi trích nội dung tại chỗ; khi tải thẳng lỗi thì dùng web_fetch của Claude
  // ("anthropic", provider do bản vá thêm; request phụ chạy bằng anthropicSearch.fetchModel). Không có
  // dịch vụ trích xuất nào khác trong thứ tự; người dùng tự thêm tên provider vào fetchRouting.providers nếu cần.
  addJson(join(dir, "web-search.json"), {
    workflow: "none",
    webSearch: { allowedProviders: ["anthropic"] },
    searchRouting: {
      providers: ["anthropic"], useCurrentModel: true,
      fallbackOn: ["network", "transient", "quota", "invalid-response", "unsupported"],
    },
    fetchRouting: { providers: ["http", "anthropic"] },
    anthropicSearch: { fetchModel: "anthropic/claude-haiku-5-5" },
    githubClone: { enabled: false },
    // Ctrl+Shift+W là phím đóng tab của WezTerm.
    shortcuts: { activity: "alt+w" },
  });
  addJson(join(dir, "open-tui.json"), readJson("open-tui"));
  addJson(join(dir, "subagents.json"), readJson("subagents"));
  addJson(join(dir, "advisor.json"), { ...models.advisor, ...readJson("advisor") });
  addText(join(dir, "AGENTS.md"), readText("AGENTS.md"));
  for (const role of SUBAGENT_ROLES) addText(join(dir, "agents", `${role}.md`), setRoleModel(readText(`roles/${role}.md`), models.subagents[role]));
  return result;
}
