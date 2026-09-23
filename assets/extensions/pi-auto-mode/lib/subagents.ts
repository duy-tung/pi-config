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
  /** Hỏi người dùng ở phiên gốc; undefined khi gốc không có UI. */
  ask?(title: string): Promise<boolean>;
}

interface Registry {
  roots: Map<string, RootHandle>;
  parents: Map<string, string>;
}

const KEY = Symbol.for("pi-auto-mode.registry.v1");

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
