import * as ai from "@earendil-works/pi-ai";

// Test transport only. No SDK HTTP provider or live credential is used.
export default function (pi) {
  for (const [provider,ids] of [["config-test",["parent"]],["openai-codex",["gpt-5.6-sol"]],["opencode-go",["glm-5.3-flash"]]]) pi.registerProvider(provider, {
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:9",
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
      const key = [...text.matchAll(/CASE:([a-z0-9_-]+)/g)].at(-1)?.[1] ?? control.fallbackKey;
      control.seen.push({ key, model: model.id, options, messages: context.messages });
      const content = control.plans[key]?.shift() ?? [{ type: "text", text: "SCRIPT_COMPLETE" }];
      const message = {
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
      return stream;
    },
  });
}
