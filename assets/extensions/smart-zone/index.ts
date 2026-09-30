import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetReport } from "./lib/budget.ts";
import { COMPACTION_NOTICE, crossedUp, DEFAULT_EDGE, parseTokens, statusText, type Zone, zoneHint } from "./lib/zone.ts";

const STATUS_KEY = "smart-zone";

/**
 * Ranh giới pha của quy trình skills (work/PHASE-BOUNDARIES.md):
 * - footer báo vùng context theo mép smart zone (TSTACK_SMART_ZONE, mặc định 150k): xanh, vàng gần mép, đỏ quá mép;
 *   lần đầu vượt lên vàng hoặc đỏ thì kèm một nhắc ngắn vào lượt kế tiếp để agent cũng biết (model không thấy footer);
 * - khi auto-compaction chạy (ngưỡng hoặc tràn), nhắc rằng một ranh giới pha đã bị bỏ lỡ;
 * - /context-budget đo phần context luôn-bật (system prompt, AGENTS.md, danh sách skill, định nghĩa tool) và đưa báo cáo
 *   vào hội thoại để agent đọc được (skill context-audit dùng nó), không tự mở lượt mới.
 * Agent con và chế độ print không có footer nên bỏ qua.
 */
export default function smartZone(pi: ExtensionAPI) {
  const edge = parseTokens(process.env.TSTACK_SMART_ZONE, DEFAULT_EDGE);
  let lastZone: Zone | undefined;

  const publish = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const tokens = ctx.getContextUsage()?.tokens;
      const { zone, text } = statusText(tokens, edge);
      const color = zone === "red" ? "error" : zone === "yellow" ? "warning" : "success";
      ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg(color, text) : undefined);
      if (typeof tokens === "number" && crossedUp(lastZone, zone)) {
        void pi.sendMessage({ customType: "smart-zone", content: zoneHint(zone, tokens, edge), display: false }, { deliverAs: "nextTurn" });
      }
      if (zone) lastZone = zone;
    } catch {
      // Context cũ sau /new, /resume hoặc /reload.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    lastZone = undefined;
    publish(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    publish(ctx);
  });
  pi.on("session_compact", (event, ctx) => {
    lastZone = undefined;
    publish(ctx);
    if (event.reason === "manual" || !ctx.hasUI) return;
    try {
      ctx.ui.notify(COMPACTION_NOTICE, "warning");
    } catch {
      // Context cũ.
    }
  });

  pi.registerCommand("context-budget", {
    description: "Đo context luôn-bật: system prompt, AGENTS.md, danh sách skill và định nghĩa tool",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const report = budgetReport({
        systemPrompt: ctx.getSystemPrompt(),
        activeTools: pi.getActiveTools(),
        tools: pi.getAllTools(),
        skills: options.skills ?? [],
        usage: ctx.getContextUsage(),
        edge,
      });
      // Hiện trong hội thoại và vào context của lượt sau; đang chạy thì Pi nối vào cuối lượt hiện tại.
      await pi.sendMessage({ customType: "context-budget", content: report, display: true }, { triggerTurn: false });
    },
  });
}
