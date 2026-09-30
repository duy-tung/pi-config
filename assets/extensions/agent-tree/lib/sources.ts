import fs from "node:fs";
import path from "node:path";

/**
 * Đọc cấu hình thật của cây agent từ agent dir: vai subagent (agents/*.md), advisor.json, subagents.json và
 * autoMode trong settings.json. File thiếu hoặc hỏng thì trả giá trị "không biết", không ném lỗi.
 */

export interface RoleInfo {
  name: string;
  model?: string;
  thinking?: string;
}

export type AdvisorGate = "plan" | "failure" | "completion";

export interface AdvisorInfo {
  /** advisor.json có tồn tại và đọc được. */
  configured: boolean;
  alwaysOn: boolean;
  model?: string;
  effort?: string;
  /** Gate đang bật; thiếu trong advisor.json thì pi-advisor-flow mặc định bật. */
  gates: AdvisorGate[];
  /** Số lần gọi tối đa mỗi phiên; undefined là không giới hạn. */
  maxCalls?: number;
}

export interface AutoModeInfo {
  /** Model xét phần bị gắn cờ (giai đoạn 2): autoMode.stage2Model ?? autoMode.model; thiếu thì dùng model của phiên. */
  model?: string;
  reasoning: string;
  /** autoMode.jev khác false. Có key TypeSafe hay không chỉ pi-auto-mode biết. */
  jev: boolean;
}

export interface Sources {
  roles: RoleInfo[];
  advisor: AdvisorInfo;
  maxConcurrent: number;
  autoMode: AutoModeInfo;
}

/** Vai hiện trước (theo sơ đồ cây agent); vai khác theo thứ tự chữ cái. */
export const ROLE_ORDER = ["worker", "explorer", "researcher"];
/** Mặc định của pi-subagents 0.19.0 (agent-manager.ts DEFAULT_MAX_CONCURRENT) khi subagents.json không đặt. */
export const DEFAULT_MAX_CONCURRENT = 10;
const MAX_CONCURRENT_CEILING = 1_000;
const GATES: [AdvisorGate, string][] = [["plan", "advisorPlanGate"], ["failure", "advisorFailureGate"], ["completion", "advisorCompletionGate"]];

/** Frontmatter "key: value" giữa hai dòng --- ở đầu file; bỏ dấu nháy bao quanh giá trị. */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const fields: Record<string, string> = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (!field || Object.hasOwn(fields, field[1])) continue;
    fields[field[1]] = field[2].replace(/^(["'])(.*)\1$/u, "$2");
  }
  return fields;
}

export function sortRoles(roles: RoleInfo[]): RoleInfo[] {
  const rank = (name: string) => {
    const at = ROLE_ORDER.indexOf(name);
    return at < 0 ? ROLE_ORDER.length : at;
  };
  return [...roles].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** Thinking phổ biến nhất giữa các vai; hoà thì lấy vai đứng trước theo thứ tự hiển thị. */
export function dominantThinking(roles: RoleInfo[]): string | undefined {
  const counts = new Map<string, number>();
  for (const role of sortRoles(roles)) if (role.thinking) counts.set(role.thinking, (counts.get(role.thinking) ?? 0) + 1);
  let best: string | undefined;
  for (const [level, count] of counts) if (best === undefined || count > (counts.get(best) ?? 0)) best = level;
  return best;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function readRoles(agentDir: string): RoleInfo[] {
  const dir = path.join(agentDir, "agents");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const roles: RoleInfo[] = [];
  for (const file of names) {
    try {
      const fields = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8"));
      roles.push({ name: text(fields.name) ?? file.slice(0, -3), model: text(fields.model), thinking: text(fields.thinking) });
    } catch {
      /* file không đọc được */
    }
  }
  return sortRoles(roles);
}

export function readAdvisor(agentDir: string): AdvisorInfo {
  const config = readJson(path.join(agentDir, "advisor.json"));
  const calls = config?.advisorMaxCallsPerSession;
  return {
    configured: !!config,
    alwaysOn: config?.alwaysOn === true,
    model: text(config?.advisor),
    effort: text(config?.advisorEffort),
    gates: GATES.filter(([, key]) => config?.[key] !== false).map(([gate]) => gate),
    maxCalls: typeof calls === "number" && Number.isInteger(calls) && calls >= 0 ? calls : undefined,
  };
}

/** maxConcurrent hợp lệ như pi-subagents (số nguyên 1..1000), ngược lại undefined. */
export function validConcurrency(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENT_CEILING ? value : undefined;
}

/** Như pi-subagents: <agentDir>/subagents.json, <cwd>/.pi/subagents.json ghi đè. */
export function readMaxConcurrent(agentDir: string, cwd: string): number {
  const project = validConcurrency(readJson(path.join(cwd, ".pi", "subagents.json"))?.maxConcurrent);
  return project ?? validConcurrency(readJson(path.join(agentDir, "subagents.json"))?.maxConcurrent) ?? DEFAULT_MAX_CONCURRENT;
}

export function readAutoMode(agentDir: string): AutoModeInfo {
  const settings = readJson(path.join(agentDir, "settings.json"));
  const auto = settings?.autoMode && typeof settings.autoMode === "object" ? settings.autoMode as Record<string, unknown> : {};
  const jev = auto.jev;
  return {
    model: text(auto.stage2Model) ?? text(auto.model),
    reasoning: text(auto.stage2Reasoning) ?? "low",
    jev: jev !== false && !(jev && typeof jev === "object" && (jev as Record<string, unknown>).enabled === false) && process.env.PI_AUTO_MODE_JEV !== "0",
  };
}

export function readSources(agentDir: string, cwd: string): Sources {
  return { roles: readRoles(agentDir), advisor: readAdvisor(agentDir), maxConcurrent: readMaxConcurrent(agentDir, cwd), autoMode: readAutoMode(agentDir) };
}
