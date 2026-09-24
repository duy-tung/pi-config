import * as ai from "@earendil-works/pi-ai";

// Test transport only. No SDK HTTP provider or live credential is used.
// openai-codex giữ api/baseUrl của Codex thật để extension nhận ra model Codex chính thức
// (pi-usage thêm service_tier khi fast mode bật); request vẫn chỉ đi qua streamSimple giả.
const codex = { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
export default function (pi) {
  for (const [provider,ids,wire] of [["config-test",["parent"]],["openai-codex",["gpt-6-sol","gpt-6-astra"],codex],["opencode-go",["glm-5.3-flash"]]]) pi.registerProvider(provider, {
    api: wire?.api ?? "anthropic-messages",
    baseUrl: wire?.baseUrl ?? "http://127.0.0.1:9",
    apiKey: "local-fixture-no-network",
    models: ids.map((id) => ({
      id, name: id, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096,
    })),
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const control = globalThis[Symbol.for("pi-config:test")];
      const text = context.messages.filter((message) => message.role === "user")
        .map((message) => typeof message.content === "string" ? message.content
          : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).at(-1) || "";
      // Bộ phân loại của pi-auto-mode: trả lời từ hàng đợi riêng (mặc định cho phép).
      const serialized = JSON.stringify(context);
      const classifier = serialized.includes("You are the permission classifier for Pi");
      // Advisor và goal auditor có system prompt riêng; hội thoại dựng lại vẫn chứa CASE của parent nên tách trước.
      const role = classifier ? "classifier" : serialized.includes("You are the Advisor: a senior engineer") ? "advisor"
        : serialized.includes("You are a read-only completion auditor") ? "auditor" : undefined;
      const key = role ?? [...text.matchAll(/CASE:([a-z0-9_-]+)/g)].at(-1)?.[1] ?? control.fallbackKey;
      void (async () => {
        await Promise.resolve(); // Phát sự kiện sau khi agent đã nhận stream.
        // Như provider thật: payload đi qua hook before_provider_request của extension trước khi gửi.
        const payload = typeof options?.onPayload === "function" ? await options.onPayload({ model: model.id }, model) : undefined;
        // Pi 0.87 khai báo tool cho model bằng system message trong transcript.
        const tools = ai.getCurrentTools(context.messages).map((tool) => tool.name);
        control.seen.push({ key, model: model.id, options, payload, tools, messages: context.messages, systemPrompt: context.systemPrompt });
        const content = classifier
          ? [{ type: "text", text: control.classifier?.shift() ?? "<block>no</block>" }]
          : control.plans[key]?.shift() ?? [{ type: "text", text: "SCRIPT_COMPLETE" }];
        const message = {
          role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message);
      })();
      return stream;
    },
  });
}
