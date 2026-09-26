import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
  DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSelectListTheme, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, SelectList, type SelectItem, Spacer, Text } from "@earendil-works/pi-tui";
import { type Action, completions, levelOf, levelOptions, mainMenu, type Menu, roleMenu, type RoleValue, splitArgs } from "./lib/menu.ts";

/**
 * /models: pi-models ngay trong phiên Pi. Cùng lệnh, cùng kiểm tra, cùng cách gộp và khóa với pi-models của bản cài
 * (<root>/bin/models.mjs), nhưng kiểm model và đăng nhập bằng catalog của chính phiên này, rồi áp ngay phần áp được:
 * phiên chính đổi model/thinking, auto mode đọc lại model của bộ phân loại. Không có tham số thì mở menu.
 */

// pi-auto-mode đọc lại model của bộ phân loại khi nhận sự kiện này và ghi "autoMode" vào applied.
const MODEL_ROLES_EVENT = "pi-config:model-roles-changed";
const GOAL_WHEN = "ở phiên mới (/new, /resume) hoặc phiên Pi mở sau";
const AUTH_SOURCES: Record<string, string> = {
  runtime: "key của phiên", environment: "biến môi trường", fallback: "key mặc định",
  models_json_key: "key trong models.json", models_json_command: "lệnh trong models.json",
};

interface Out {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}
interface CatalogReport {
  errors: string[];
  notes: string[];
  loggedOut: { provider: string; roles: string[] }[];
}
interface Catalog {
  check(roles: Record<string, RoleValue>, options?: { logins?: boolean }): Promise<CatalogReport>;
  list(): Promise<{ id: string; name: string; login?: string; models: { id: string; levels: string[] }[] }[]>;
}
interface Profile {
  agentDir: string;
  runtime: string;
}
interface Resolved {
  preset: string;
  roles: Record<string, RoleValue>;
  errors: string[];
}
type Presets = Record<string, { description?: string; roles: Record<string, RoleValue> }>;
// Hàm của runtime/model-roles.mjs và runtime/models.mjs (chép vào <root>/bin khi cài).
interface RolesModule {
  ROLES: string[];
  THINKING_LEVELS: string[];
  MODEL_ROLES_FILE: string;
  catalogReport(options: {
    roles: Record<string, RoleValue>; find: (provider: string, id: string) => unknown;
    clamp: (model: never, level: never) => string; login?: (provider: string) => string | undefined;
  }): Promise<CatalogReport>;
  loadPresets(file: string): Presets;
  readModelRoles(agentDir: string): { file: string; exists: boolean; config?: unknown; error?: string };
  resolveModelRoles(presets: Presets, config?: unknown): Resolved;
  effectiveModelRoles(agentDir: string): Record<string, RoleValue>;
  driftedRoles(roles: Record<string, RoleValue>, effective: Record<string, RoleValue>): string[];
  parseModelRef(value: unknown): { provider: string; id: string } | undefined;
  withoutRoles(config: unknown, roles: string[]): unknown;
}
interface ModelsModule {
  runModels(options: {
    root: string; profiles: Record<string, Profile>; args: string[]; out: Out; command: string; catalog: Catalog;
    effects: (changed: string[]) => Promise<string[]>;
  }): Promise<number>;
  whenApplied(changed: string[], when?: Record<string, string>): string[];
}
interface Install {
  root: string;
  agentDir: string;
  profiles: Record<string, Profile>;
  roles: RolesModule;
  models: ModelsModule;
}
interface Result {
  status: number;
  lines: string[];
  level: "info" | "warning" | "error";
}
type Run = (args: string[], out: Out) => Promise<number>;

const samePath = (a: string, b: string) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** Bản cài chứa extension này: <root>/assets/extensions/model-roles. */
async function loadInstall(): Promise<Install> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const profilesFile = path.join(root, "profiles.json");
  for (const file of [path.join(root, "install-state.json"), path.join(root, "bin", "models.mjs"), profilesFile]) {
    if (!fs.existsSync(file)) throw new Error(`/models chỉ dùng được trong bản cài của pi-config (không có ${file}).`);
  }
  const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8")) as Record<string, Profile>;
  const agentDir = getAgentDir();
  if (!profiles.main || !samePath(profiles.main.agentDir, agentDir)) {
    throw new Error(`/models quản lý agent dir của bản cài (${profiles.main?.agentDir}); phiên này dùng ${agentDir}.`);
  }
  const load = (name: string) => import(pathToFileURL(path.join(root, "bin", name)).href);
  return { root, agentDir, profiles, roles: await load("model-roles.mjs") as RolesModule, models: await load("models.mjs") as ModelsModule };
}

/** Catalog và trạng thái đăng nhập của chính phiên này: không đọc auth.json, không chạy lệnh của key. */
function sessionCatalog(ctx: ExtensionContext, roles: RolesModule): Catalog {
  const registry = ctx.modelRegistry;
  const login = (provider: string) => {
    const status = registry.getProviderAuthStatus(provider);
    if (!status.configured) return undefined;
    if (status.source === "stored") {
      const model = registry.getAll().find((item) => item.provider === provider);
      return model && registry.isUsingOAuth(model) ? "OAuth" : "API key đã lưu";
    }
    return status.label ?? AUTH_SOURCES[status.source ?? ""] ?? "đã cấu hình";
  };
  return {
    check: (wanted, { logins = false } = {}) => roles.catalogReport({
      roles: wanted, find: (provider, id) => registry.find(provider, id),
      clamp: clampThinkingLevel as unknown as (model: never, level: never) => string, login: logins ? login : undefined,
    }),
    list: async () => {
      const byProvider = new Map<string, Model<Api>[]>();
      for (const model of registry.getAll()) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
      return [...byProvider].map(([id, models]) => ({
        id, name: registry.getProviderDisplayName(id), login: login(id),
        models: models.map((model) => ({ id: model.id, levels: getSupportedThinkingLevels(model) as string[] })),
      })).sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

const sessionLabel = (pi: ExtensionAPI, ctx: ExtensionContext) =>
  ctx.model ? `${ctx.model.provider}/${ctx.model.id} · ${pi.getThinkingLevel()}` : undefined;

/** Đưa phiên này về model/thinking mới của vai main. */
async function switchSession(pi: ExtensionAPI, ctx: ExtensionContext, install: Install, main: RoleValue): Promise<string> {
  const keep = `Phiên này giữ ${sessionLabel(pi, ctx) ?? "model đang dùng"}`;
  const ref = install.roles.parseModelRef(main.model);
  const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
  if (!model) return `${keep}: không có ${main.model} trong catalog.`;
  if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id) {
    let switched = false;
    try {
      switched = await pi.setModel(model);
    } catch {
      switched = false;
    }
    if (!switched) return `${keep}: provider ${model.provider} chưa đăng nhập (/login); main dùng ${main.model} ở phiên Pi mở sau.`;
  }
  if (main.thinking) pi.setThinkingLevel(main.thinking as ThinkingLevel);
  return `Phiên này dùng ${sessionLabel(pi, ctx)}.`;
}

/** effects của runModels trong phiên: áp ngay main và auto mode, báo thời điểm của các vai còn lại. */
async function applyToSession(pi: ExtensionAPI, ctx: ExtensionContext, install: Install, changed: string[]): Promise<string[]> {
  const when: Record<string, string> = { auditor: GOAL_WHEN, oracle: GOAL_WHEN };
  if (changed.includes("autoMode")) {
    const payload = { applied: [] as string[] };
    pi.events.emit(MODEL_ROLES_EVENT, payload);
    if (payload.applied.includes("autoMode")) when.autoMode = "ở lần phân loại kế tiếp của auto mode";
  }
  const lines = install.models.whenApplied(changed.filter((name) => name !== "main"), when);
  if (changed.includes("main")) lines.push(await switchSession(pi, ctx, install, install.roles.effectiveModelRoles(install.agentDir).main));
  return lines;
}

async function capture(run: Run, args: string[]): Promise<Result> {
  const lines: string[] = [];
  let level: Result["level"] = "info";
  const status = await run(args, {
    log: (line) => lines.push(line),
    warn: (line) => {
      lines.push(line);
      if (level === "info") level = "warning";
    },
    error: (line) => {
      lines.push(line);
      level = "error";
    },
  });
  return { status, lines, level: status ? "error" : level };
}

// Pi thay thông báo info liền trước bằng thông báo mới: mỗi lệnh gửi một thông báo gộp mọi dòng.
const show = (ctx: ExtensionContext, result: Result) => ctx.ui.notify(result.lines.join("\n"), result.level);

async function choose(ctx: ExtensionContext, menu: Menu): Promise<Action | undefined> {
  const choice = await ctx.ui.select(menu.title, menu.options);
  return choice === undefined ? undefined : menu.actions[menu.options.indexOf(choice)];
}

/** Danh sách lọc được bằng cách gõ (danh sách model dài hơn màn hình); Enter chọn, Esc huỷ. */
class SearchList extends Container implements Focusable {
  private readonly input = new Input();
  private readonly holder = new Container();
  private list: SelectList;
  private isFocused = false;

  constructor(private readonly items: SelectItem[], title: string, theme: Theme, private readonly done: (value: string | undefined) => void) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(this.holder);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "gõ để lọc · ↑↓ chọn · Enter xác nhận · Esc huỷ"), 1, 0));
    this.addChild(new DynamicBorder());
    this.list = this.build("");
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  private build(query: string): SelectList {
    const shown = query ? fuzzyFilter(this.items, query, (item) => `${item.value} ${item.description ?? ""}`) : this.items;
    const list = new SelectList(shown, 12, getSelectListTheme());
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(undefined);
    this.holder.clear();
    this.holder.addChild(list);
    return list;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((key) => keys.matches(data, key as never))) {
      this.list.handleInput(data);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.list = this.build(this.input.getValue());
  }
}

/**
 * Chọn model cho một vai: model của provider đã đăng nhập đứng trước. TUI có ô lọc trên cả catalog; RPC chỉ liệt kê
 * model dùng được và cho nhập provider/id.
 */
async function pickModel(ctx: ExtensionContext, role: string, current?: string): Promise<Model<Api> | undefined> {
  const registry = ctx.modelRegistry;
  const ref = (model: Model<Api>) => `${model.provider}/${model.id}`;
  const ready = new Set(registry.getAvailable().map(ref));
  const rank = (model: Model<Api>) => (ref(model) === current ? 0 : ready.has(ref(model)) ? 1 : 2);
  const models = registry.getAll().filter((model) => rank(model) < 2 || ctx.mode === "tui")
    .sort((a, b) => rank(a) - rank(b) || ref(a).localeCompare(ref(b)));
  const find = (value: string | undefined) => models.find((model) => ref(model) === value);
  const title = `Model cho ${role}`;
  if (ctx.mode === "tui") {
    const items = models.map((model) => ({
      value: ref(model), label: ref(model),
      description: [model.name, ref(model) === current ? "đang dùng" : ready.has(ref(model)) ? "" : "chưa đăng nhập"].filter(Boolean).join(" · "),
    }));
    return find(await ctx.ui.custom<string | undefined>((_tui, theme, _keys, done) => new SearchList(items, title, theme, done)));
  }
  const other = "Nhập provider/id khác…";
  const choice = await ctx.ui.select(title, [...models.map((model) => (ref(model) === current ? `${ref(model)} (đang dùng)` : ref(model))), other]);
  if (choice === undefined) return undefined;
  if (choice !== other) return find(choice.split(" ")[0]);
  const typed = (await ctx.ui.input(title, "provider/id"))?.trim();
  const slash = typed?.indexOf("/") ?? -1;
  return typed && slash > 0 ? registry.find(typed.slice(0, slash), typed.slice(slash + 1)) : undefined;
}

async function pickLevel(ctx: ExtensionContext, role: string, model: Model<Api> | undefined, current?: string, levels?: string[]) {
  const options = levelOptions(model ? getSupportedThinkingLevels(model) as string[] : levels ?? [], current);
  const choice = await ctx.ui.select(`Thinking cho ${role}${model ? ` (${model.provider}/${model.id})` : ""}`, options);
  return choice === undefined ? undefined : levelOf(choice);
}

/** Menu của một vai → tham số lệnh (set/reset), hoặc undefined khi huỷ. */
async function roleArgs(ctx: ExtensionContext, install: Install, name: string, config: unknown, resolved: Resolved, presets: Presets) {
  const wanted = resolved.roles[name];
  const fallback = install.roles.resolveModelRoles(presets, install.roles.withoutRoles(config, [name])).roles[name];
  const action = await choose(ctx, roleMenu(name, wanted, fallback));
  if (!action || !("pick" in action)) return action && "args" in action ? action.args : undefined;
  const ref = install.roles.parseModelRef(wanted.model);
  const currentModel = ref && ctx.modelRegistry.find(ref.provider, ref.id);
  if (action.pick === "thinking") {
    const level = await pickLevel(ctx, name, currentModel, wanted.thinking, install.roles.THINKING_LEVELS);
    return level ? ["set", name, level] : undefined;
  }
  const model = await pickModel(ctx, name, wanted.model);
  if (!model) return undefined;
  const level = await pickLevel(ctx, name, model, wanted.thinking);
  return level ? ["set", name, `${model.provider}/${model.id}`, level] : undefined;
}

async function presetArgs(ctx: ExtensionContext, presets: Presets, config: unknown, current: string) {
  const custom = config && typeof config === "object" && (config as { presets?: unknown }).presets;
  const names = [...Object.keys(presets), ...Object.keys(custom && typeof custom === "object" ? custom : {})];
  const options = names.map((name) => {
    const description = presets[name]?.description ?? (custom as Record<string, { description?: string }>)[name]?.description;
    return `${name}${name === current ? " (đang dùng)" : ""}${description ? `: ${description}` : ""}`;
  });
  const choice = await ctx.ui.select("Preset", options);
  return choice === undefined ? undefined : ["preset", names[options.indexOf(choice)]];
}

/** /models không tham số: bảng các vai làm menu; mỗi thay đổi được xem trước rồi mới ghi. */
async function openMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, install: Install, run: Run) {
  const { roles } = install;
  const presets = roles.loadPresets(path.join(install.root, "assets", "configs", "model-presets.json"));
  const current = roles.readModelRoles(install.agentDir);
  const resolved = current.error ? undefined : roles.resolveModelRoles(presets, current.config);
  if (!resolved || resolved.errors.length) {
    show(ctx, await capture(run, []));
    return;
  }
  const effective = roles.effectiveModelRoles(install.agentDir);
  const drifted = Object.fromEntries(roles.driftedRoles(resolved.roles, effective).map((name) => [name, effective[name]]));
  const action = await choose(ctx, mainMenu({
    preset: resolved.preset, file: current.exists ? current.file : `chưa có ${roles.MODEL_ROLES_FILE}`,
    session: sessionLabel(pi, ctx), roles: resolved.roles, names: roles.ROLES, drifted,
  }));
  if (!action) return;
  const args = "args" in action ? action.args
    : "preset" in action ? await presetArgs(ctx, presets, current.config, resolved.preset)
    : "role" in action ? await roleArgs(ctx, install, action.role, current.config, resolved, presets) : undefined;
  if (!args) return;
  const preview = await capture(run, [...args, "--dry-run"]);
  if (preview.status) {
    show(ctx, preview);
    return;
  }
  // Dòng đầu của bản xem trước là "Xem trước (--dry-run), chưa ghi file nào."
  if (await ctx.ui.confirm(`/models ${args.join(" ")}`, preview.lines.slice(1).join("\n"))) show(ctx, await capture(run, args));
}

export default function modelRoles(pi: ExtensionAPI) {
  let latest: ExtensionContext | undefined;
  let install: Promise<Install> | undefined;
  const getInstall = () => {
    install ??= loadInstall();
    install.catch(() => {
      install = undefined;
    });
    return install;
  };

  pi.on("session_start", (_event, ctx) => {
    latest = ctx;
  });

  pi.registerCommand("models", {
    description: "Model và thinking của các vai (model-roles.json): xem, đổi, áp ngay",
    getArgumentCompletions: async (prefix) => {
      const ctx = latest;
      if (!ctx) return null;
      try {
        const { roles, root, agentDir } = await getInstall();
        const presets = roles.loadPresets(path.join(root, "assets", "configs", "model-presets.json"));
        const config = roles.readModelRoles(agentDir).config as { presets?: Record<string, { description?: string }> } | undefined;
        const custom = config?.presets && typeof config.presets === "object" ? config.presets : {};
        const registry = ctx.modelRegistry;
        return completions(prefix, {
          roles: roles.ROLES,
          presets: [...Object.entries(presets), ...Object.entries(custom)].map(([name, preset]) => ({ name, description: preset?.description })),
          providers: [...new Set(registry.getAll().map((model) => model.provider))].sort(),
          models: registry.getAvailable().map((model) => ({ ref: `${model.provider}/${model.id}`, description: model.name })),
          levels: roles.THINKING_LEVELS,
        }, fuzzyFilter);
      } catch {
        return null;
      }
    },
    handler: async (text, ctx) => {
      latest = ctx;
      let loaded: Install;
      try {
        loaded = await getInstall();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const run: Run = (args, out) => loaded.models.runModels({
        root: loaded.root, profiles: loaded.profiles, args, out, command: "/models", catalog: sessionCatalog(ctx, loaded.roles),
        effects: (changed) => applyToSession(pi, ctx, loaded, changed),
      });
      const args = splitArgs(text);
      if (!args.length && ctx.hasUI) {
        await openMenu(pi, ctx, loaded, run);
        return;
      }
      const result = await capture(run, args);
      const session = sessionLabel(pi, ctx);
      if ((!args.length || args[0] === "show") && session) result.lines.push(`Phiên này: ${session}`);
      show(ctx, result);
    },
  });
}
