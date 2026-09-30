import { formatTokens } from "./zone.ts";

/**
 * /context-budget: phần context luôn-bật của mỗi request, đo trên system prompt hiện tại và định nghĩa tool đang bật.
 * Token ước lượng bằng ký tự/4 như ước lượng của Pi (thường cao hơn thực tế một chút); dùng để so sánh các phần với
 * nhau và trước/sau khi cắt tỉa, không phải con số hoá đơn.
 */
export const estimate = (chars: number): number => Math.ceil(chars / 4);

export type ToolLike = {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { path?: string; source?: string };
};
export type SkillLike = { name: string; disableModelInvocation?: boolean };
export type BudgetInput = {
  systemPrompt: string;
  activeTools: string[];
  tools: ToolLike[];
  skills?: SkillLike[];
  usage?: { tokens: number | null; contextWindow: number };
  edge: number;
};

const split = (file: string) => file.replaceAll("\\", "/").split("/");
const unescapeXml = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

/** Mỗi context file (AGENTS.md…) trong prompt: đường dẫn và số ký tự kể cả thẻ bao. */
export function contextFileEntries(prompt: string): { path: string; chars: number }[] {
  const entries: { path: string; chars: number }[] = [];
  for (const match of prompt.matchAll(/<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/gu)) {
    entries.push({ path: match[1], chars: match[0].length });
  }
  return entries;
}

/** Khối <available_skills> trong prompt: tổng ký tự và từng skill theo location. */
export function skillEntries(prompt: string): { chars: number; skills: { location: string; chars: number }[] } {
  const start = prompt.indexOf("<available_skills>");
  const end = prompt.indexOf("</available_skills>");
  if (start < 0 || end < start) return { chars: 0, skills: [] };
  // Tính cả đoạn dẫn phía trước (hướng dẫn đọc skill) mà Pi đặt ngay trên khối.
  const lead = prompt.lastIndexOf("The following skills provide specialized instructions", start);
  const block = prompt.slice(lead >= 0 && lead > start - 600 ? lead : start, end + "</available_skills>".length);
  const skills = [...block.matchAll(/<skill>[\s\S]*?<location>([\s\S]*?)<\/location>[\s\S]*?<\/skill>/gu)]
    .map((match) => ({ location: unescapeXml(match[1].trim()), chars: match[0].length }));
  return { chars: block.length, skills };
}

/** Thư mục gốc chứa các thư mục skill: .../skills/<tên>/SKILL.md → .../skills. */
export function skillRoot(location: string): string {
  const parts = split(location);
  return parts.length > 2 ? parts.slice(0, -2).join("/") : parts.join("/");
}

/** Nguồn của một tool: tên package trong node_modules, tên thư mục extension, hoặc built-in. */
export function toolSource(tool: ToolLike): string {
  const file = tool.sourceInfo?.path;
  if (!file) return tool.sourceInfo?.source || "built-in";
  const parts = split(file);
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && parts[modules + 1]) {
    return parts[modules + 1].startsWith("@") ? `${parts[modules + 1]}/${parts[modules + 2] ?? ""}` : parts[modules + 1];
  }
  const name = parts.at(-1) ?? file;
  return /^index\.[cm]?[jt]s$/u.test(name) ? (parts.at(-2) ?? name) : name.replace(/\.[cm]?[jt]s$/u, "");
}

const toolChars = (tool: ToolLike) =>
  JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} }).length;

function groups<T>(items: T[], key: (item: T) => string, chars: (item: T) => number) {
  const map = new Map<string, { chars: number; items: T[] }>();
  for (const item of items) {
    const entry = map.get(key(item)) ?? { chars: 0, items: [] };
    entry.chars += chars(item);
    entry.items.push(item);
    map.set(key(item), entry);
  }
  return [...map.entries()].sort((a, b) => b[1].chars - a[1].chars);
}

/** 564 → "564", 1_300 → "1.3k", 42_300 → "42k": đủ chi tiết để so các phần nhỏ với nhau. */
const tokens = (chars: number) => {
  const count = estimate(chars);
  if (count < 1000) return String(count);
  return count < 10_000 ? `${Number((count / 1000).toFixed(1))}k` : formatTokens(count);
};

export function budgetReport(input: BudgetInput): string {
  const lines: string[] = ["Context luôn-bật (ước lượng ký tự/4, trên system prompt và tool đang bật):"];
  const promptChars = input.systemPrompt.length;
  const files = contextFileEntries(input.systemPrompt);
  const filesChars = files.reduce((sum, file) => sum + file.chars, 0);
  const skills = skillEntries(input.systemPrompt);
  lines.push(`System prompt ≈ ${tokens(promptChars)} token`);
  lines.push(`  Prompt gốc, hướng dẫn tool, cwd ≈ ${tokens(Math.max(0, promptChars - filesChars - skills.chars))}`);
  lines.push(`  Context file (${files.length}) ≈ ${tokens(filesChars)}`);
  for (const file of [...files].sort((a, b) => b.chars - a.chars)) lines.push(`    ${file.path} ≈ ${tokens(file.chars)}`);
  const hidden = (input.skills ?? []).filter((skill) => skill.disableModelInvocation).length;
  lines.push(`  Danh sách skill (${skills.skills.length} skill model thấy; ${hidden} skill chỉ người gọi, 0 token) ≈ ${tokens(skills.chars)}`);
  for (const [root, entry] of groups(skills.skills, (skill) => skillRoot(skill.location), (skill) => skill.chars)) {
    lines.push(`    ${root} ≈ ${tokens(entry.chars)} (${entry.items.length})`);
  }
  const active = new Set(input.activeTools);
  const tools = input.tools.filter((tool) => active.has(tool.name));
  const toolsChars = tools.reduce((sum, tool) => sum + toolChars(tool), 0);
  lines.push(`Định nghĩa tool đang bật (${tools.length}) ≈ ${tokens(toolsChars)} token`);
  for (const [source, entry] of groups(tools, toolSource, toolChars)) {
    const names = entry.items.map((tool) => tool.name);
    const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")}, +${names.length - 6}` : names.join(", ");
    lines.push(`  ${source} ≈ ${tokens(entry.chars)} (${names.length}): ${shown}`);
  }
  const total = estimate(promptChars) + estimate(toolsChars);
  let tail = `Tổng luôn-bật ≈ ${tokens(total * 4)} · mép smart zone ${formatTokens(input.edge)}`;
  if (input.usage && typeof input.usage.tokens === "number") {
    tail += ` · context hiện tại ${formatTokens(input.usage.tokens)}/${formatTokens(input.usage.contextWindow)}`;
  }
  lines.push(tail);
  lines.push("Thân skill, skill chỉ người gọi và tool chưa kích hoạt không tốn token cho tới khi dùng. Cắt tỉa: /skill:context-audit.");
  return lines.join("\n");
}
