/** Tham số của /permissions: không có → menu (hoặc trạng thái khi không có UI); `test <lệnh bash>` → chạy thử. */
export type PermissionsArgs = { kind: "menu" } | { kind: "test"; command: string } | { kind: "usage"; message: string };

export const TEST_USAGE = "Usage: /permissions test <bash command>";

export function parsePermissionsArgs(args: string): PermissionsArgs {
  const trimmed = args.trim();
  const match = /^test(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return trimmed ? { kind: "usage", message: `Unknown argument "${trimmed}". ${TEST_USAGE}, or /permissions for the menu.` } : { kind: "menu" };
  const command = match[1]?.trim();
  return command ? { kind: "test", command } : { kind: "usage", message: TEST_USAGE };
}

/** Gợi ý tham số: chỉ có `test `, khi phần đã gõ là tiền tố của nó. */
export function permissionsCompletions(prefix: string): { value: string; label: string; description: string }[] {
  return "test ".startsWith(prefix.trimStart()) && !prefix.trimStart().startsWith("test ")
    ? [{ value: "test ", label: "test", description: "dry run the permission decision for a bash command" }]
    : [];
}
