import fs from "node:fs";
import path from "node:path";
import type { PermissionMode } from "./config.ts";

/**
 * Subagent của @tintinweb/pi-subagents chạy trong cùng process, mỗi phiên con có
 * instance extension riêng và không có UI. Registry toàn process (Symbol.for) nối phiên
 * con với phiên gốc: con dùng mode của gốc, lấy tin nhắn thật của người dùng ở gốc làm
 * neo ý định, và hỏi người dùng qua UI của gốc.
 */
export interface RootHandle {
  sessionId: string;
  mode(): PermissionMode;
  humanMessages(): string[];
  /** Hỏi người dùng ở phiên gốc với các lựa chọn cho trước; trả lựa chọn (undefined khi bỏ qua). Không có khi gốc không có UI. */
  ask?(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>;
  /** Ô nhập ở phiên gốc (lời nhắn khi từ chối); không có khi gốc không có UI. */
  input?(title: string): Promise<string | undefined>;
  /** Đổi mode của phiên gốc từ hộp hỏi của child ("allow all edits", "switch to auto mode"); không vào bypass. */
  setMode?(mode: PermissionMode): void;
  /** Lời gọi được cho phép tới hết phiên ở manual mode, dùng chung cho phiên gốc và mọi child. */
  sessionApprovals(): Set<string>;
  /** Thư mục cho đọc tới hết phiên, dùng chung cho phiên gốc và mọi child. */
  sessionReadRoots(): Set<string>;
  /** Thư mục thêm bằng /add-dir, dùng chung cho phiên gốc và mọi child. */
  sessionDirectories(): Set<string>;
  /** Số lần hỏi rm vào đường dẫn quan trọng hết giờ, dùng chung. */
  criticalTimeouts(add?: number): number;
  /** Model phân loại và mức suy luận của phiên gốc: đổi trong /permissions thì child dùng ngay. */
  classifier(): { model?: string; stage2Reasoning: string };
}

interface Registry {
  roots: Map<string, RootHandle>;
  parents: Map<string, string>;
}

const KEY = Symbol.for("pi-auto-mode.registry.v2");

function registry(): Registry {
  const host = globalThis as unknown as Record<symbol, Registry | undefined>;
  host[KEY] ??= { roots: new Map(), parents: new Map() };
  return host[KEY] as Registry;
}

export function registerRoot(handle: RootHandle): void {
  registry().roots.set(handle.sessionId, handle);
}

export function unregisterRoot(sessionId: string): void {
  const current = registry().roots;
  current.delete(sessionId);
}

export function linkChild(childSessionId: string, parentSessionId: string | undefined): void {
  if (childSessionId && parentSessionId && childSessionId !== parentSessionId) registry().parents.set(childSessionId, parentSessionId);
}

export function unlinkChild(childSessionId: string): void {
  registry().parents.delete(childSessionId);
}

export function isChild(sessionId: string): boolean {
  return registry().parents.has(sessionId);
}

/** Phiên gốc của một phiên (theo chuỗi cha), hoặc undefined. */
export function rootFor(sessionId: string): RootHandle | undefined {
  const { roots, parents } = registry();
  let current: string | undefined = sessionId;
  for (let depth = 0; current && depth < 8; depth++) {
    const parent = parents.get(current);
    if (!parent) return roots.get(current);
    current = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Định nghĩa agent: subagent có chạy kèm cổng này không
// ---------------------------------------------------------------------------

/** Frontmatter YAML của một file agent (parseFrontmatter của Pi); ném lỗi khi YAML hỏng. */
export type FrontmatterParser = (source: string) => Record<string, unknown>;

/** Thư mục pi-subagents nạp agent (loadCustomAgents), ưu tiên thấp tới cao: agent dir, `.agents/agents`, `.pi/agents`. */
export function agentDirectories(cwd: string, agentDir: string): string[] {
  return [path.join(agentDir, "agents"), path.join(cwd, ".agents", "agents"), path.join(cwd, ".pi", "agents")];
}

/**
 * Frontmatter của agent mang tên `type`, nạp như pi-subagents: tên là `name:` (không có thì tên file), file ở thư
 * mục ưu tiên cao đè file trước, file YAML hỏng bị bỏ qua. Tên khớp không phân biệt hoa thường; nhiều agent chỉ
 * khác hoa thường thì trả về tất cả.
 */
function agentDefinitions(type: string, directories: string[], parse: FrontmatterParser): Record<string, unknown>[] {
  const agents = new Map<string, Record<string, unknown>>();
  for (const dir of directories) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      let front: Record<string, unknown>;
      try {
        front = parse(fs.readFileSync(path.join(dir, file), "utf8")) ?? {};
      } catch {
        continue;
      }
      const declared = typeof front.name === "string" ? front.name.trim() : "";
      // pi-subagents không nạp file có ":" trong name (dành cho tên theo plugin).
      if (declared.includes(":")) continue;
      agents.set(declared || path.basename(file, ".md"), front);
    }
  }
  const exact = agents.get(type);
  if (exact) return [exact];
  return [...agents].filter(([name]) => name.toLowerCase() === type.toLowerCase()).map(([, front]) => front);
}

/** Giá trị CSV của pi-subagents (chuỗi "a, b" hoặc mảng YAML); bỏ trống hoặc "none" là danh sách rỗng. */
function csvField(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const text = String(value).trim();
  if (!text || text === "none") return [];
  return text.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function ungated(front: Record<string, unknown>, input: Record<string, unknown>): boolean {
  // Frontmatter thắng tham số của lời gọi; chỉ boolean true của YAML mới là isolated (chuỗi "true" thì không).
  const isolated = front.isolated != null ? front.isolated === true : input.isolated === true;
  if (isolated) return true;
  // extensions/inherit_extensions (inheritField): bỏ trống hoặc true = mọi extension; false, "none" hoặc rỗng = không có.
  const extensions = front.extensions ?? front.inherit_extensions;
  if (extensions === false) return true;
  if (extensions !== undefined && extensions !== null && extensions !== true) {
    const names = csvField(extensions);
    if (!names.includes("*") && !names.includes("pi-auto-mode")) return true;
  }
  return csvField(front.exclude_extensions).includes("pi-auto-mode");
}

/** Subagent sẽ chạy không có cổng này: isolated, extensions:false hoặc danh sách extension thiếu pi-auto-mode. */
export function agentIsUngated(input: Record<string, unknown>, options: { cwd: string; agentDir: string; parse: FrontmatterParser }): boolean {
  const type = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  const found = type ? agentDefinitions(type, agentDirectories(options.cwd, options.agentDir), options.parse) : [];
  return (found.length ? found : [{}]).some((front) => ungated(front, input));
}
