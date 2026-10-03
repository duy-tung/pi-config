/**
 * Phần thuần của /models: nhãn và lựa chọn của menu. Không import gói của Pi để test chạy bằng Node.
 */

export interface RoleValue {
  model?: string;
  thinking?: string;
  /** Nguồn của từng trường theo model-roles.json: "default" hoặc "override". */
  source?: { model?: string; thinking?: string };
  /** File gốc quyết định giá trị đang có hiệu lực. */
  file?: string;
}

/**
 * Một thay đổi chọn trong menu (runtime/models.mjs áp): ghi đè model/thinking của một vai, bỏ ghi đè của một vai,
 * hoặc đưa mọi vai về model-roles.json (bỏ giá trị đổi ngoài file này).
 */
export type Change = { role: string; model?: string; thinking?: string } | { reset: string } | { apply: true };

const pair = (value: RoleValue | undefined) => `${value?.model ?? "?"} · ${value?.thinking ?? "?"}`;

/** Dòng của một vai trong menu /models: giá trị theo model-roles.json, và giá trị đang chạy khi lệch. */
export function roleOption(name: string, wanted: RoleValue, effective?: RoleValue): string {
  const override = Object.values(wanted.source ?? {}).includes("override") ? ", ghi đè" : "";
  const drift = effective ? `; đang chạy ${pair(effective)} theo ${effective.file}` : "";
  return `${name.padEnd(10)} ${pair(wanted)}${override}${drift}`;
}

/** Việc của một lựa chọn: mở menu của vai, áp một thay đổi, chọn model hay mức thinking của vai. */
export type Action = { role: string } | { change: Change } | { pick: "model" | "thinking" };

export interface Menu {
  title: string;
  options: string[];
  actions: Action[];
}

/**
 * Menu chính của /models: mỗi vai một dòng, rồi (khi có vai lệch) đưa các vai lệch về model-roles.json.
 * drifted: giá trị đang chạy của các vai lệch với model-roles.json.
 */
export function mainMenu(options: {
  file: string; session?: string; roles: Record<string, RoleValue>; names: string[]; drifted: Record<string, RoleValue>;
}): Menu {
  const menu: Menu = {
    title: `Model của các vai: mặc định + ghi đè (${options.file})${options.session ? `\nPhiên này: ${options.session}` : ""}`,
    options: [], actions: [],
  };
  for (const name of options.names) {
    menu.options.push(roleOption(name, options.roles[name], options.drifted[name]));
    menu.actions.push({ role: name });
  }
  const drifted = Object.keys(options.drifted);
  if (drifted.length) {
    menu.options.push(`Đưa ${drifted.join(", ")} về model-roles.json`);
    menu.actions.push({ change: { apply: true } });
  }
  return menu;
}

/** Menu của một vai: đổi model, đổi thinking, bỏ ghi đè (khi vai có ghi đè). */
export function roleMenu(name: string, wanted: RoleValue, fallback?: RoleValue): Menu {
  const menu: Menu = {
    title: `${name}: ${pair(wanted)}`,
    options: [`Đổi model… (đang dùng ${wanted.model ?? "?"})`, `Đổi thinking… (đang dùng ${wanted.thinking ?? "?"})`],
    actions: [{ pick: "model" }, { pick: "thinking" }],
  };
  if (Object.values(wanted.source ?? {}).includes("override")) {
    menu.options.push(`Bỏ ghi đè, dùng mặc định (${pair(fallback)})`);
    menu.actions.push({ change: { reset: name } });
  }
  return menu;
}

/** Lựa chọn mức thinking; mức đang dùng được đánh dấu. Trả về cùng thứ tự với levels. */
export const levelOptions = (levels: string[], current?: string): string[] =>
  levels.map((level) => (level === current ? `${level} (đang dùng)` : level));

/** Mức thinking từ lựa chọn của levelOptions. */
export const levelOf = (option: string): string => option.split(" ")[0];
