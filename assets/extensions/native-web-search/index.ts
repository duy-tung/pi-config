import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NATIVE_SEARCH_KEY, searchWithAnthropic, supportsNativeSearch } from "./lib/anthropic.ts";

/**
 * Cầu nối native search cho pi-web-access (bản vá trong assets/patches.json).
 * web_search định tuyến ["openai", "firecrawl"] với useCurrentModel: model Codex/OpenAI chính thức
 * dùng hosted web_search của pi-web-access; model Claude chính thức dùng web_search của Anthropic
 * qua cầu nối này; model khác hoặc lỗi được phép fallback sẽ dùng Firecrawl.
 */
export default function nativeWebSearch(pi: ExtensionAPI) {
  const bridge = Object.freeze({ supports: supportsNativeSearch, search: searchWithAnthropic });
  const registry = globalThis as unknown as Record<symbol, unknown>;
  registry[NATIVE_SEARCH_KEY] = bridge;
  pi.on("session_start", () => {
    registry[NATIVE_SEARCH_KEY] = bridge;
  });
  pi.on("session_shutdown", () => {
    if (registry[NATIVE_SEARCH_KEY] === bridge) delete registry[NATIVE_SEARCH_KEY];
  });
}
