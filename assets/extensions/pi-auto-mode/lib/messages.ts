import type { PermissionMode } from "./config.ts";

/** Câu chữ gửi cho model và hiển thị cho người dùng (tiếng Anh, như Claude Code/Codex). */

export function classifierDenial(rule: string | undefined, reason: string): string {
  const label = rule ? `[${rule}] ` : "";
  return [
    `Permission for this action was denied by Pi's auto mode classifier. Reason: ${label}${reason}`,
    "If other parts of your task don't depend on this action, continue with them. You may reach the goal a clearly safer way (a narrower target, a read-only check, a non-destructive alternative), but do not work around the denial — no other tool, script, encoded or split command, or sub-agent to get the same effect — and do not retry the same action.",
    "If the action is essential, finish what you can, then stop and tell the user exactly what you want to run and why, so they can approve it (the user can approve it with /permissions).",
  ].join("\n\n");
}

export function ruleDenial(reason: string): string {
  return `${reason} Do not try to achieve the same effect another way; if it is essential, ask the user.`;
}

export function unavailable(reason: string): string {
  return [
    `Auto mode could not check this action (${reason}), so it was not run. This is not a judgment that the action is unsafe.`,
    "Wait briefly and retry it unchanged. If it keeps failing, continue with other work — reads, searches and edits inside the working directory don't need the check — and tell the user.",
  ].join("\n\n");
}

export const USER_DENIED = "The user denied permission for this action. Do not retry it or work around it; ask the user how to proceed if it is essential.";

export const NO_APPROVER = "This action needs the user's approval, but no one can answer in this session, so it was not run. Continue with other work and report what you needed to the user.";

export function limitReason(limit: "consecutive" | "total", count: number, latest: string): string {
  const head = limit === "consecutive"
    ? `${count} consecutive actions were blocked by auto mode.`
    : `${count} actions were blocked by auto mode in this session.`;
  return `${head} Please review the transcript before continuing.\n\nLatest blocked action: ${latest}`;
}

export function approvalGranted(summary: string): string {
  return `Permission granted for: ${summary}. You may now retry this action if you would like.`;
}

/** Mục system prompt cho agent chính theo mode. */
export function modeInstructions(mode: PermissionMode): string {
  if (mode === "bypass") {
    return "Bypass permissions mode is active: tool calls run without permission checks, except the user's deny and ask rules; the user is asked before recursive deletes outside the system temp directory. Take extra care with destructive, irreversible or external actions, and confirm with the user when their intent is unclear.";
  }
  return [
    "Auto mode is active: an automatic permission classifier checks riskier tool calls before they run, and there are no approval prompts. Keep working without asking for routine confirmations.",
    "Before a command that could discard uncommitted work, check git status and commit or stash first.",
    "If an action is denied, do not retry it unchanged or look for a workaround. Take a safer path; if the action is essential, tell the user at the end of your turn exactly what you need and why.",
  ].join(" ");
}

export const BYPASS_WARNING = [
  "WARNING: Pi running in Bypass Permissions mode",
  "",
  "In Bypass Permissions mode, Pi will not check or ask before running potentially dangerous commands. Only your deny and ask rules still apply, and Pi still asks before recursive deletes outside the temp directory.",
  "Use it only in a sandboxed container or VM with restricted internet access that can easily be restored if damaged.",
  "By proceeding, you accept all responsibility for actions taken in Bypass Permissions mode.",
].join("\n");

export const JEV_NOTICE = "Auto mode can screen actions with Jev, TypeSafe's System One model: routine commands are cleared without an LLM call and only risky ones reach the LLM classifier. Store a TypeSafe API key with `pi-mcp-adapter key set systemone` in a terminal, then restart Pi. Until then the LLM classifier screens every action. /auto-mode shows the status.";

export const AUTO_NOTICE ="Auto mode lets Pi handle permission prompts automatically: a classifier checks each risky tool call before it runs. Actions it judges safe run; risky ones are blocked and Pi tries another approach. It can make mistakes, so prefer isolated environments for sensitive work. Shift+Tab switches mode; /permissions shows recent denials.";
