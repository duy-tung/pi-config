/**
 * Smart zone: chất lượng của model giữ ổn trong khoảng 150k token đầu của cửa sổ context, sau đó giảm dần
 * ("dumb zone"). Với cửa sổ 1M, auto-compaction chỉ chạy gần cuối cửa sổ nên không còn là tín hiệu; footer
 * báo vùng theo mép này để người dùng chọn ranh giới pha đúng lúc.
 */
export const DEFAULT_EDGE = 150_000;

export type Zone = "green" | "yellow" | "red";

/** "150k", "1m", "200000" → số token; giá trị sai hoặc không dương → fallback. */
export function parseTokens(value: string | undefined, fallback = DEFAULT_EDGE): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/iu.exec(value ?? "");
  if (!match) return fallback;
  const unit = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
  const tokens = Math.round(Number(match[1]) * unit);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : fallback;
}

/** Xanh dưới 2/3 mép, vàng tới mép, đỏ khi quá mép. */
export function zoneOf(tokens: number, edge: number): Zone {
  if (tokens >= edge) return "red";
  if (tokens >= (edge * 2) / 3) return "yellow";
  return "green";
}

/** 950 → "1k", 42_300 → "42k", 1_000_000 → "1M", 1_500_000 → "1.5M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.max(1, Math.round(tokens / 1_000))}k`;
}

/** Nhãn footer; tokens null (ngay sau compaction, chưa có phản hồi mới) thì không hiện gì. */
export function statusText(tokens: number | null | undefined, edge: number): { zone?: Zone; text?: string } {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return {};
  const zone = zoneOf(tokens, edge);
  const used = `${formatTokens(tokens)}/${formatTokens(edge)}`;
  if (zone === "green") return { zone, text: `zone ${used}` };
  if (zone === "yellow") return { zone, text: `zone ${used} gần mép` };
  return { zone, text: `dumb zone ${used} · /clear, handoff hoặc /compact ở ranh giới` };
}

/**
 * Nhắc cho model khi context vừa vượt lên vàng hoặc đỏ: footer chỉ người dùng thấy, còn quyết định ở ranh giới pha
 * (work/PHASE-BOUNDARIES.md) cần cả agent biết để đề xuất đúng lúc. Mỗi lần vượt ngưỡng chỉ nhắc một lần.
 */
export function zoneHint(zone: Zone, tokens: number, edge: number): string {
  const used = `${formatTokens(tokens)}/${formatTokens(edge)}`;
  return zone === "red"
    ? `[smart-zone] Context ${used}: đã quá mép smart zone. Ở ranh giới pha kế tiếp, đề xuất với người dùng /clear, ` +
      "/skill:handoff, giao subagent hoặc /compact kèm chỉ dẫn; không cắt ngang giữa pha."
    : `[smart-zone] Context ${used}: gần mép smart zone. Hết pha này thì chọn ranh giới (tiếp tục, /clear, handoff, ` +
      "subagent hoặc /compact) thay vì kéo sang pha mới.";
}

const RANK: Record<Zone, number> = { green: 0, yellow: 1, red: 2 };
/** Có nhắc khi chuyển từ vùng before sang after không: chỉ khi đi lên (xanh→vàng, vàng→đỏ, xanh→đỏ). */
export const crossedUp = (before: Zone | undefined, after: Zone | undefined): after is "yellow" | "red" =>
  after !== undefined && after !== "green" && RANK[after] > RANK[before ?? "green"];

export const COMPACTION_NOTICE =
  "Auto-compaction vừa chạy: một ranh giới pha đã bị bỏ lỡ. Lần sau quyết định ngay ở ranh giới: tiếp tục, /clear, " +
  "/skill:handoff, giao subagent, hoặc /compact kèm chỉ dẫn. Việc chạy dài giữ trạng thái trong .tstack/<slug>/.";
