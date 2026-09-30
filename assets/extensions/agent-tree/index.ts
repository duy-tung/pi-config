import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { agentTree } from "./lib/tree.ts";

/**
 * Cây agent của phiên, dựng từ dữ liệu thật:
 * - main: model, thinking và cửa sổ context của phiên chính;
 * - advisor (pi-advisor-flow, advisor.json): model, effort, số lần đã hỏi / tối đa, gate đang bật, lời khuyên gần nhất;
 * - jev (pi-auto-mode, sự kiện pi-config:auto-mode-decision): số lệnh Jev cho chạy thẳng (sharp) và số bị gắn cờ
 *   đẩy lên model xét kỹ (split, autoMode.stage2Model của settings.json);
 * - agents (pi-subagents, agents/*.md, subagents.json): model/thinking từng vai, số đang chạy / maxConcurrent;
 * - log: sự kiện gần nhất có giờ (subagent bắt đầu/xong/lỗi, advisor, jev split, lệnh bị chặn, compaction).
 * Footer luôn có một dòng ngắn; /agent-tree [on|off] bật/tắt widget đầy đủ. Agent con và chế độ print bỏ qua.
 */
export default function agentTreeExtension(pi: ExtensionAPI) {
  agentTree(pi, { agentDir: getAgentDir, truncate: (text, width) => truncateToWidth(text, width) });
}
