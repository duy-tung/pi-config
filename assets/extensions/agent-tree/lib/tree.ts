import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WIDTH, type Line, statusLine, type View, widgetLines } from "./format.ts";
import { readSources, type Sources, validConcurrency } from "./sources.ts";
import {
  ADVISOR_TOOL, applyAdvisor, applyDecision, applySubagent, createState, DECISION_EVENT, pushLog, SUBAGENT_EVENTS, type Tone,
  type TreeState,
} from "./state.ts";

const KEY = "agent-tree";
/** /models (extension model-roles) vừa ghi model/thinking của các vai. */
const MODEL_ROLES_EVENT = "pi-config:model-roles-changed";

export interface TreeDeps {
  /** getAgentDir() của Pi; truyền vào để test chạy không cần runtime Pi. */
  agentDir: () => string;
  /** Cắt dòng đã tô màu theo độ rộng hiển thị (truncateToWidth của pi-tui); thiếu thì giữ nguyên. */
  truncate?: (text: string, width: number) => string;
  now?: () => number;
}

type Painter = { fg(color: Tone, text: string): string };

export function paint(theme: Painter, line: Line): string {
  return line.map((segment) => (segment.tone && segment.text.trim() ? theme.fg(segment.tone, segment.text) : segment.text)).join("");
}

/**
 * Nối sự kiện của Pi, pi-subagents, pi-advisor-flow và pi-auto-mode vào state, rồi cập nhật footer và widget.
 * Chỉ phiên có UI (không phải agent con, không phải chế độ print) mới hiện; handler không bao giờ ném lỗi
 * (context cũ sau /new, /resume, /reload).
 */
export function agentTree(pi: ExtensionAPI, deps: TreeDeps): void {
  const now = deps.now ?? Date.now;
  let state: TreeState = createState();
  let sources: Sources | undefined;
  /** maxConcurrent đổi qua /agents → Settings trong phiên (có thể không ghi file): thắng giá trị đọc từ file. */
  let concurrency: number | undefined;
  let latest: ExtensionContext | undefined;
  let widgetOn = false;
  /** Widget component (TUI) đang gắn: yêu cầu vẽ lại thay vì dựng lại. */
  let mounted: { requestRender(): void } | undefined;
  let lastView: View | undefined;
  /** Nội dung widget dạng chữ (RPC) đã gửi, để không gửi lại khi không đổi. */
  let sentLines = "";

  const load = (ctx: ExtensionContext) => {
    try {
      const read = readSources(deps.agentDir(), ctx.cwd);
      sources = concurrency ? { ...read, maxConcurrent: concurrency } : read;
    } catch {
      /* giữ số liệu cũ */
    }
  };

  const view = (ctx: ExtensionContext): View | undefined => {
    if (!sources) return undefined;
    const model = ctx.model;
    return {
      main: { model: model ? `${model.provider}/${model.id}` : undefined, thinking: pi.getThinkingLevel(), contextWindow: model?.contextWindow },
      sources, state,
    };
  };

  const mount = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(KEY, (tui, theme) => {
        mounted = tui;
        return {
          render(width: number): string[] {
            try {
              if (!lastView) return [];
              return widgetLines(lastView, width).map((line) => {
                const text = paint(theme, line);
                return deps.truncate ? deps.truncate(text, width) : text;
              });
            } catch {
              return [];
            }
          },
          invalidate() {},
          dispose() {
            if (mounted === tui) mounted = undefined;
          },
        };
      });
      return;
    }
    // RPC chỉ nhận widget dạng mảng chữ.
    const lines = lastView ? widgetLines(lastView, DEFAULT_WIDTH).map((line) => paint(ctx.ui.theme, line)) : [];
    const joined = lines.join("\n");
    if (joined === sentLines) return;
    sentLines = joined;
    ctx.ui.setWidget(KEY, lines);
  };

  const publish = (ctx: ExtensionContext | undefined, remount = false) => {
    if (!ctx?.hasUI) return;
    try {
      // Đọc lại mỗi lần: /advisor-off, /advisor-settings, /agents và /models ghi các file này trong phiên.
      load(ctx);
      const current = view(ctx);
      if (!current) return;
      lastView = current;
      ctx.ui.setStatus(KEY, paint(ctx.ui.theme, statusLine(current)));
      if (!widgetOn) return;
      if (mounted && !remount) mounted.requestRender();
      else mount(ctx);
    } catch {
      // Context cũ sau /new, /resume hoặc /reload.
    }
  };

  const track = (ctx: ExtensionContext) => {
    latest = ctx;
    publish(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    latest = ctx;
    state = createState();
    mounted = undefined;
    sentLines = "";
    if (!ctx.hasUI) return;
    publish(ctx, true);
  });
  pi.on("turn_end", (_event, ctx) => track(ctx));
  pi.on("model_select", (_event, ctx) => track(ctx));
  pi.on("thinking_level_select", (_event, ctx) => track(ctx));
  pi.on("tool_execution_end", (event, ctx) => {
    latest = ctx;
    if (event.toolName !== ADVISOR_TOOL) return;
    applyAdvisor(state, event, now());
    publish(ctx);
  });
  pi.on("session_compact", (event, ctx) => {
    latest = ctx;
    pushLog(state, { at: now(), text: `main compact context (${event.reason})`, tone: "warning" });
    publish(ctx);
  });

  for (const kind of SUBAGENT_EVENTS) {
    pi.events.on(`subagents:${kind}`, (payload) => {
      if (applySubagent(state, kind, payload, now())) publish(latest);
    });
  }
  pi.events.on(DECISION_EVENT, (payload) => {
    if (applyDecision(state, payload, now())) publish(latest);
  });
  // /agents → Settings đổi maxConcurrent trong phiên.
  pi.events.on("subagents:settings_changed", (payload) => {
    const settings = (payload as { settings?: { maxConcurrent?: unknown } } | undefined)?.settings;
    const value = validConcurrency(settings?.maxConcurrent);
    if (!value) return;
    concurrency = value;
    if (sources) sources = { ...sources, maxConcurrent: value };
    publish(latest);
  });
  pi.events.on(MODEL_ROLES_EVENT, () => {
    if (!latest) return;
    load(latest);
    publish(latest);
  });

  pi.registerCommand("agent-tree", {
    description: "Hiện/ẩn cây agent: main, advisor, jev, subagent và nhật ký phiên (/agent-tree [on|off])",
    getArgumentCompletions: (prefix) => ["on", "off"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off") {
        if (ctx.hasUI) ctx.ui.notify("Cách dùng: /agent-tree [on|off]", "warning");
        return;
      }
      widgetOn = arg ? arg === "on" : !widgetOn;
      latest = ctx;
      load(ctx);
      if (!ctx.hasUI) return;
      try {
        if (!widgetOn) {
          mounted = undefined;
          sentLines = "";
          ctx.ui.setWidget(KEY, undefined);
        }
      } catch {
        /* context cũ */
      }
      publish(ctx, true);
    },
  });
}
