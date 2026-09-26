/**
 * Phần thuần của /models: tách tham số, gợi ý tham số và nhãn menu. Không import gói của Pi để test chạy bằng Node.
 */

export interface RoleValue {
  model?: string;
  thinking?: string;
  /** Nguồn của từng trường theo model-roles.json: "preset" hoặc "override". */
  source?: { model?: string; thinking?: string };
  /** File gốc quyết định giá trị đang có hiệu lực. */
  file?: string;
}

export interface Completion {
  value: string;
  label: string;
  description?: string;
}

export interface CompletionData {
  roles: string[];
  presets: { name: string; description?: string }[];
  providers: string[];
  /** Model gợi ý cho /models set, dạng provider/id. */
  models: { ref: string; description?: string }[];
  levels: string[];
}

/** Lọc và xếp theo mức khớp (fuzzyFilter của pi-tui trong phiên Pi). */
export type Filter = <T>(items: T[], query: string, text: (item: T) => string) => T[];

export const COMMANDS: [string, string][] = [
  ["show", "bảng model của mọi vai"],
  ["list", "provider và model trong catalog"],
  ["preset", "chọn preset"],
  ["set", "ghi đè model/thinking của một vai"],
  ["reset", "bỏ ghi đè của vai"],
  ["adopt", "ghi giá trị đang chạy của vai lệch vào model-roles.json"],
  ["apply", "áp model-roles.json vào file gốc"],
  ["help", "hướng dẫn"],
];

const FLAGS: Record<string, string[]> = {
  preset: ["--dry-run"], set: ["--dry-run"], reset: ["--all", "--dry-run"], adopt: ["--dry-run"], apply: ["--reset", "--dry-run"],
};

/** Tham số của /models: tên vai, provider/id, mức thinking và cờ đều không chứa khoảng trắng. */
export const splitArgs = (text: string): string[] => text.trim().split(/\s+/u).filter(Boolean);

/**
 * Gợi ý cho phần tham số đang gõ (prefix: mọi thứ sau "/models "). value là cả chuỗi tham số với từ cuối được thay,
 * vì Pi thay toàn bộ prefix bằng value.
 */
export function completions(prefix: string, data: CompletionData, filter: Filter): Completion[] | null {
  const tokens = prefix.split(/\s+/u);
  const last = tokens.pop() ?? "";
  const head = prefix.slice(0, prefix.length - last.length);
  const [command, ...args] = tokens.filter(Boolean);
  let candidates: [string, string?][] = [];
  if (command === undefined) candidates = COMMANDS;
  else if (last.startsWith("-")) candidates = (FLAGS[command] ?? []).filter((flag) => !args.includes(flag)).map((flag) => [flag]);
  else {
    const positional = args.filter((arg) => !arg.startsWith("--"));
    if (command === "preset" && !positional.length) candidates = data.presets.map((preset) => [preset.name, preset.description]);
    else if (command === "list" && !positional.length) candidates = data.providers.map((provider) => [provider]);
    else if (command === "set" && !positional.length) candidates = data.roles.map((role) => [role]);
    else if (command === "set" && positional.length < 3) {
      const values = positional.slice(1);
      if (!values.some((value) => value.includes("/"))) candidates.push(...data.models.map(({ ref, description }): [string, string?] => [ref, description]));
      if (!values.some((value) => data.levels.includes(value))) candidates.push(...data.levels.map((level): [string, string?] => [level, "thinking"]));
    } else if (command === "reset" || command === "adopt") candidates = data.roles.filter((role) => !positional.includes(role)).map((role) => [role]);
  }
  const matched = filter(candidates, last, ([value]) => value);
  return matched.length ? matched.map(([value, description]) => ({ value: head + value, label: value, ...(description ? { description } : {}) })) : null;
}

const pair = (value: RoleValue | undefined) => `${value?.model ?? "?"} · ${value?.thinking ?? "?"}`;

/** Dòng của một vai trong menu /models: giá trị theo model-roles.json, và giá trị đang chạy khi lệch. */
export function roleOption(name: string, wanted: RoleValue, effective?: RoleValue): string {
  const override = wanted.source?.model === "override" || wanted.source?.thinking === "override" ? ", ghi đè" : "";
  const drift = effective ? `; đang chạy ${pair(effective)} theo ${effective.file}` : "";
  return `${name.padEnd(10)} ${pair(wanted)}${override}${drift}`;
}

/** Việc của một lựa chọn: mở menu của vai, chạy lệnh với args, chọn preset, chọn model hay mức thinking của vai. */
export type Action = { role: string } | { args: string[] } | { preset: true } | { pick: "model" | "thinking" };

export interface Menu {
  title: string;
  options: string[];
  actions: Action[];
}

/**
 * Menu chính của /models: mỗi vai một dòng, rồi chọn preset và (khi có vai lệch) giữ hoặc bỏ giá trị đang chạy.
 * drifted: giá trị đang chạy của các vai lệch với model-roles.json.
 */
export function mainMenu(options: {
  preset: string; file: string; session?: string; roles: Record<string, RoleValue>; names: string[]; drifted: Record<string, RoleValue>;
}): Menu {
  const menu: Menu = {
    title: `Model của các vai: preset ${options.preset} (${options.file})${options.session ? `\nPhiên này: ${options.session}` : ""}`,
    options: [], actions: [],
  };
  for (const name of options.names) {
    menu.options.push(roleOption(name, options.roles[name], options.drifted[name]));
    menu.actions.push({ role: name });
  }
  menu.options.push(`Chọn preset… (đang dùng ${options.preset})`);
  menu.actions.push({ preset: true });
  const drifted = Object.keys(options.drifted);
  if (drifted.length) {
    menu.options.push(`Giữ giá trị đang chạy của ${drifted.join(", ")} (adopt)`, `Đưa ${drifted.join(", ")} về model-roles.json (apply --reset)`);
    menu.actions.push({ args: ["adopt"] }, { args: ["apply", "--reset"] });
  }
  return menu;
}

/** Menu của một vai: đổi model, đổi thinking, bỏ ghi đè (khi vai có ghi đè). */
export function roleMenu(name: string, wanted: RoleValue, preset?: RoleValue): Menu {
  const menu: Menu = {
    title: `${name}: ${pair(wanted)}`,
    options: [`Đổi model… (đang dùng ${wanted.model ?? "?"})`, `Đổi thinking… (đang dùng ${wanted.thinking ?? "?"})`],
    actions: [{ pick: "model" }, { pick: "thinking" }],
  };
  if (wanted.source?.model === "override" || wanted.source?.thinking === "override") {
    menu.options.push(`Bỏ ghi đè, dùng preset (${pair(preset)})`);
    menu.actions.push({ args: ["reset", name] });
  }
  return menu;
}

/** Lựa chọn mức thinking; mức đang dùng được đánh dấu. Trả về cùng thứ tự với levels. */
export const levelOptions = (levels: string[], current?: string): string[] =>
  levels.map((level) => (level === current ? `${level} (đang dùng)` : level));

/** Mức thinking từ lựa chọn của levelOptions. */
export const levelOf = (option: string): string => option.split(" ")[0];
