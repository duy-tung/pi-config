import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceAssets = fileURLToPath(new URL("../assets/", import.meta.url));
const roleNames = ["researcher", "worker", "debugger", "reviewer"];
const common = [
  "@gotgenes/pi-anthropic-auth",
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "@juicesharp/rpiv-todo",
  "pi-mcp-adapter",
  "pi-web-access",
  "@narumitw/pi-usage",
];
const uiPackages = ["pi-open-tui"];
const definitions = {
  main: {
    runtime: "current", provider: "openai-codex", model: "gpt-6-astra", thinking: "high",
    theme: "rose-pine-moon", packages: [...common, "@tintinweb/pi-subagents", "pi-lens", "pi-goal-x", "pi-workspace-history", "pi-background-tasks", "pi-advisor-flow", ...uiPackages],
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
 */
export function buildConfiguration({ root, agentDir, binDir, nodePath, platform = process.platform, home, repoDir, shellPath }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const [name, value] of Object.entries({ root, agentDir, binDir, nodePath, home })) {
    if (typeof value !== "string" || !paths.isAbsolute(value)) {
      throw new Error(`${name} phải là đường dẫn tuyệt đối của ${platform}.`);
    }
  }
  const assets = repoDir ? path.join(repoDir, "assets") : sourceAssets;
  const readText = (name) => fs.readFileSync(path.join(assets, name), "utf8");
  const readJson = (name) => JSON.parse(readText(`configs/${name}.json`));
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
  // Upstream Firecrawl CLI 1.23.3 derives these paths from os.homedir().
  const firecrawlCredentials = platform === "darwin"
    ? join(home, "Library", "Application Support", "firecrawl-cli", "*")
    : platform === "win32"
      ? join(home, "AppData", "Roaming", "firecrawl-cli", "*")
      : join(home, ".config", "firecrawl-cli", "*");
  const protectedPaths = [
    join(home, ".ssh", "*"), join(home, ".aws", "*"), join(home, ".config", "gcloud", "*"),
    join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(agentDir, "auth.json"), join(root, "profiles", "*", "auth.json"),
    join(root, "secrets", "*.env"), join(root, "backups", "**"),
    join(home, ".local", "share", "pi-retired", "**"), firecrawlCredentials,
  ];
  const policy = {
    permission: {
      "*": "ask", read: "allow", grep: "allow", find: "allow", ls: "allow", write: "allow", edit: "allow",
      Agent: "allow", get_subagent_result: "allow", steer_subagent: "allow", SubagentWorkflow: "ask",
      mcpScript: "deny", todo: "allow", ask_user_question: "allow", web_search: "allow",
      fetch_content: "allow", get_search_content: "allow",
      path: {
        "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow",
        ...Object.fromEntries(protectedPaths.map((entry) => [glob(entry), "deny"])),
        "**/credentials.json": "deny",
      },
      external_directory: { "*": "ask", [glob(join(root, "sources", "mattpocock-skills", "*"))]: "allow" },
      external_directory_read: {
        [glob(join(root, "sources", "firecrawl-cli-source", "skills", "*"))]: "allow",
        [glob(join(root, "sources", "firecrawl-workflows", "skills", "*"))]: "allow",
      },
      bash: {
        "*": "ask", pwd: "allow", "ls *": "allow", "rg *": "allow", "git status*": "allow",
        "git diff*": "allow", "git log*": "allow", "rm -rf *": "deny", "sudo *": "deny", "*firecrawl-key.cjs*": "deny",
      },
      mcp: { "*": "ask" }, skill: "allow",
    },
    shellTools: { bg_run: { commandArgument: "command", workdirArgument: "cwd" } },
  };
  for (const [name, profile] of Object.entries(profiles)) {
    const definition = definitions[name];
    const dir = profile.agentDir;
    const hasAgents = profile.packages.includes("@tintinweb/pi-subagents");
    const settings = {
      defaultProvider: definition.provider, defaultModel: definition.model, defaultThinkingLevel: definition.thinking,
      modelThinkingLevels: { "openai-codex/gpt-5.6-sol": "high", "openai-codex/gpt-6-astra": "high", "opencode-go/glm-5.3-flash": "max" },
      defaultProjectTrust: "ask", packages: profile.packages.map((pkg) => {
        const source = join(root, "runtimes", profile.runtime, "node_modules", pkg);
        return pkg === "pi-background-tasks" ? { source, extensions: ["extensions/background-tasks.ts"] } : source;
      }),
      skills, warnings: { anthropicExtraUsage: true },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, cacheWarming: "off",
      theme: definition.theme,
      extensions: [join(targetAssets, "extensions", "rose-pine-palette.ts")],
      themes: [join(targetAssets, "themes")], quietStartup: true, showHardwareCursor: true,
    };
    if (shellPath) settings.shellPath = shellPath;
    settings.enabledModels = ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "opencode-go/glm-5.3-flash"];
    settings.workspaceHistory = {
      enabled: "auto", allowHomeDirectory: false, storageDir: join(root, "state", "workspace-history"),
      maxSessionsPerWorkspace: 3, maxWorkspaces: 10,
    };
    addJson(join(dir, "settings.json"), settings);
    const modelOverrides = { "gpt-5.6-sol": { contextWindow: 872000 } };
    modelOverrides["gpt-6-astra"] = { contextWindow: 872000 };
    const providerModels = { modelOverrides };
    addJson(join(dir, "models.json"), { providers: { "openai-codex": providerModels } });
    addJson(join(dir, "extensions", "pi-permission-system", "config.json"), policy);
    addJson(join(dir, "mcp.json"), {
      settings: { hostConfigDiscovery: "off" },
      mcpServers: { workspace: {
        command: nodePath, args: [join(root, "bin", "workspace-mcp.mjs")],
        cwd: "${PI_WORKSPACE_DIR}", inheritEnv: false, lifecycle: "lazy",
        includeTools: ["read_text_file", "list_directory", "get_file_info", "list_allowed_directories"],
      } },
    });
    addJson(join(dir, "web-search.json"), {
      provider: "firecrawl", workflow: "none", allowBrowserCookies: false,
      searchRouting: { providers: ["firecrawl"], useCurrentModel: false, fallbackOn: ["network", "transient"] },
      fetchRouting: { providers: ["firecrawl"], allowRemoteHostedProviders: true }, githubClone: { enabled: false },
      firecrawlBaseUrl: "https://api.firecrawl.dev", firecrawlApiKey: helperCommand,
      firecrawlApiVersion: "v2", firecrawlFreshScrape: true,
    });
    addJson(join(dir, "open-tui.json"), readJson("open-tui"));
    if (hasAgents) addJson(join(dir, "subagents.json"), readJson("subagents"));
    addJson(join(dir, "advisor.json"), readJson("advisor"));
    addJson(join(dir, "pi-goal-x-settings.json"), readJson("goal"));
    if (name === "main") addJson(join(dir, "pi-usage.json"), { codexFastMode: true });
    addText(join(dir, "AGENTS.md"), readText("AGENTS.md"));
    if (hasAgents) for (const role of roleNames) addText(join(dir, "agents", `${role}.md`), readText(`roles/${role}.md`));
  }
  addJson(join(root, "profiles.json"), profiles);
  addJson(join(root, "config", "pi-lens.json"), readJson("lens"));
  return result;
}
