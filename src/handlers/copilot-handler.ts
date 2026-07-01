import forge from "node-forge";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, HandlerInput, HandlerResult, countConsecutiveNags, stripNagMessages, RECENTLY_COMPLETED, RECENT_BODIES, injectIdentity, getProjectRoot, scrubTaskComplete, compressToolDefinitions, stripCopilotGreeting, normalizeToolCallId, safePreviewFromContent } from "../shared.ts";
import { chatCompletion as openAIChat, storeReasoning, getModelCtx, modelHasVision, detectSessionSignal, extractUserPrompt, getModelDisplayName, getModelProviderTag } from "./openai-provider.ts";
import { chatCompletion as freebuffChat, getFreebuffModelPremium } from "./freebuff-client.ts";
import { chatCompletion as agnesChat } from "./agnes-client.ts";
import { getCompletionsModel } from "./dashboard-handler.ts";
import { completions as codestralFim } from "./codestral-client.ts";
import { chatCompletion as bitnetChat } from "./bitnet-client.ts";
import { chatCompletion as umansChat, anthropicChatCompletion as umansAnthropicChat } from "./umans-client.ts";
import { isSupermavenEnabled, isSupermavenReady, supermavenCodeComplete } from "./supermaven-client.ts";
import { reqLog, agentTag } from "../split-console.ts";
import { trackRequest } from "../usage-tracker.ts";
import { repairToolCalls, detectApologyText, detectToolLoop, bumpSalvageStat, extractNameFromToolId } from "../tool-salvager.ts";
import { StreamResponseLogger } from "../streaming-log.ts";
import { anthropicToOpenAIRequest } from "./anthropic-bridge.ts";
import { ensureVSModels, VS_MODELS, detectVendor } from "./vs/models.ts";

function isProviderRouted(model: string): boolean {
  if (model.startsWith("freebuff/")) return true;
  if (model.startsWith("agnes")) return true;
  if (model.startsWith("codestral/") || model.startsWith("mistral-")) return true;
  if (model === "bitnet-demo" || model.startsWith("bitnet/")) return true;
  if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") return true;
  if (model.startsWith("pol/")) return true;
  if (model.startsWith("openrouter/")) return true;
  return false;
}

function routeChat(model: string, messages: any[], tools: any[] | undefined, stream: boolean, extra: Record<string, any>, session?: { keyIdx?: number; sessionLabel?: string }): Promise<Response> {
  if (model.startsWith("freebuff/")) return freebuffChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, temperature: extra.temperature, top_p: extra.top_p, ...extra });
  if (model.startsWith("agnes")) return agnesChat(model, messages, tools, stream, { ...extra });
  if (model.startsWith("codestral/") || model.startsWith("mistral-")) return codestralChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, temperature: extra.temperature, top_p: extra.top_p });
  if (model === "bitnet-demo" || model.startsWith("bitnet/")) return bitnetChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, temperature: extra.temperature, top_p: extra.top_p });
  if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") return umansChat(model, messages, tools, stream, { ...extra });
  // OC-GO upstream removed — unknown/unprefixed models are rejected.
  return openAIChat(model, messages, tools, stream, extra, session?.keyIdx, session?.sessionLabel);
}

const FAKE_MODELS = VS_MODELS;
let _lastUserContent = "";
let _lastRealModel = "deepseek-v4-pro";

async function ensureModels() {
  await ensureVSModels();
}

const chatSessions = new Map<any, any>();

function createSession(model = "gpt-4o") {
  const id = `session-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  const now = Math.floor(Date.now() / 1000);
  const session = {
    id, model, created_at: now, expires_at: now + 3600,
    state: { thread: [], turn_id: 0 }, messages: [],
  };
  chatSessions.set(id, session);
  return session;
}

function generateCopilotCompletion(content: string, model: string) {
  if (model.startsWith("claude")) {
    return generateClaudeResponse(content, model);
  }
  return generateGPTResponse(content, model);
}

function generateGPTResponse(content: string, model: string) {
  const lower = content.toLowerCase();
  if (lower.includes("explain") || lower.includes("what does") || lower.includes("how does")) {
    return `Sure! Let me explain that.\n\n\`\`\`\n// This is a mock response from the local proxy\n// The real Copilot API is bypassed entirely\n\`\`\`\n\nThe code above demonstrates the pattern you're asking about. In practice, you'd see a real explanation here based on your actual codebase.\n\nIs there anything specific you'd like me to elaborate on?`;
  }
  if (lower.includes("fix") || lower.includes("bug") || lower.includes("error")) {
    return `I can see the issue. Here's the fix:\n\n\`\`\`diff\n- // problematic code\n+ // fixed code\n\`\`\`\n\nThe main problem was that the logic didn't handle the edge case properly. Let me know if you need more details!`;
  }
  return `That's a great question! Here's what I know about that:\n\nBased on the context of your codebase, here are some relevant observations:\n\n1. The code structure suggests a well-organized project\n2. There are patterns that could be optimized\n3. I can help you refactor this if you'd like\n\nWould you like me to dive deeper into any specific aspect?`;
}

// Extract filename from user request
function extractFilename(content: string): string | null {
  const m = content.match(/(?:create|write|make|save)[\s]+(?:a[\s]+)?(?:file[\s]+(?:called|named)?[\s]+)?["']?([a-zA-Z0-9_.\-/]+\.(?:css|js|ts|jsx|tsx|py|html|json|md|txt|rs|go|java|c|cpp|h|hpp))["']?/i);
  if (m) return m[1];
  const m2 = content.match(/["']([a-zA-Z0-9_.\-/]+\.(?:css|js|ts|jsx|tsx|py|html|json|md|txt|rs|go|java|c|cpp|h|hpp))["']/i);
  if (m2) return m2[1];
  return null;
}

// Generate CSS content for a file
function generateCSSContent(filename: string): string {
  return `/* Generated by Copilot - ${filename} */\nbody {\n  background-color: black;\n  color: white;\n  margin: 0;\n  padding: 0;\n  font-family: system-ui, sans-serif;\n}\n\n.container {\n  max-width: 1200px;\n  margin: 0 auto;\n  padding: 20px;\n}\n`;
}

// Generate JS/TS content
function generateJSContent(filename: string): string {
  return `// Generated by Copilot - ${filename}\nexport function init(): void {\n  console.log('Initialized ${filename}');\n}\n\nexport default init;\n`;
}

// Generate Python content
function generatePyContent(filename: string): string {
  return `# Generated by Copilot - ${filename}\ndef main():\n    print("Hello from ${filename}")\n\nif __name__ == "__main__":\n    main()\n`;
}

function generateClaudeResponse(content: string, model: string) {
  const lower = content.toLowerCase();
  if (lower.includes("hello") || lower.includes("hi")) {
    return "Hey! I'm Claude in Copilot. Happy to help you code, debug, or think through problems. What are we building today?";
  }
  if (lower.includes("explain") || lower.includes("what does") || lower.includes("how does")) {
    return `Let me break this down for you.\n\n**Key insights:**\n\n1. The pattern you're looking at follows standard conventions\n2. It handles edge cases by checking preconditions\n3. The return type ensures type safety\n\nHere's a concrete example:\n\n\`\`\`typescript\n// Example demonstrating the pattern\nfunction demonstrate(): void {\n  // Mock implementation via local proxy\n  console.log("Claude in Copilot - auth bypassed via MITM");\n}\n\`\`\`\n\nDoes this help clarify things? I can go into more detail on any part.`;
  }
  if (lower.includes("fix") || lower.includes("bug") || lower.includes("error")) {
    return `I found the issue! Here's what's wrong and how to fix it:\n\n**Root cause:** The condition doesn't account for the null case.\n\n**Fix:**\n\n\`\`\`javascript\n// Before\nif (result.value) { process(result.value); }\n\n// After\nif (result?.value) { process(result.value); } else { handleMissing(); }\n\`\`\`\n\nThis ensures we handle both the case where result is null and where result.value is falsy.`;
  }
  if (lower.includes("create") || lower.includes("write") || lower.includes("implement") || lower.includes("make") || lower.includes("file")) {
    const isCSS = lower.includes(".css") || lower.includes("css") || lower.includes("style");
    if (isCSS) {
      return `I'll create that CSS file for you:\n\n\`\`\`css\n/* Generated by Copilot */\nbody {\n  background-color: black;\n  color: white;\n  margin: 0;\n  padding: 0;\n}\n\`\`\`\n\nThis sets up a dark theme. Want me to add more styles?`;
    }
    return `Here's an implementation for that:\n\n\`\`\`typescript\n// Generated by Copilot\nexport function createFile(): string {\n  return "File created successfully";\n}\n\`\`\`\n\nWant me to adjust the approach?`;
  }
  return `Good question. Let me think about this.\n\n**Summary:** The approach you're considering looks reasonable, but there are a few things to keep in mind:\n\n1. **Performance** - The current implementation should handle most cases efficiently\n2. **Edge cases** - Make sure to handle empty/null inputs\n3. **Testing** - Consider writing unit tests for the boundary conditions\n\nLet me know if you need more specific guidance on any of these points!`;
}

function generateStreamingResponse(content: string, model: string, finishReason = "stop") {
  const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
  const created = Math.floor(Date.now() / 1000);
  const systemFingerprint = `fp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;

  let result = `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","system_fingerprint":"${systemFingerprint}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null,"logprobs":null}]}\n\n`;

  const words = content.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i++) {
    const escapedContent = words[i]
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","system_fingerprint":"${systemFingerprint}","choices":[{"index":0,"delta":{"content":"${escapedContent}"},"finish_reason":null,"logprobs":null}]}\n\n`;
  }

  result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","system_fingerprint":"${systemFingerprint}","choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}","logprobs":null}]}\n\n`;
  result += "data: [DONE]\n\n";
  return result;
}

function generateToolCallResponse(model: string) {
  const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCallId = `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
  const systemFingerprint = `fp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;

  const toolCall = {
    id: toolCallId,
    type: "function",
    function: {
      name: "MOCK-read_file",
      arguments: JSON.stringify({ path: "/example/file.ts" }),
    },
  };

  let result = `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","system_fingerprint":"${systemFingerprint}","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[${JSON.stringify(toolCall)}]},"finish_reason":null,"logprobs":null}]}\n\n`;
  result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","system_fingerprint":"${systemFingerprint}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","logprobs":null}]}\n\n`;
  result += "data: [DONE]\n\n";
  return result;
}

const THINKING_TAG_PARAMS: Record<string, Record<string, string>> = {
  LOW: { reasoningEffort: "low" },
  MEDIUM: { reasoningEffort: "medium" },
  HIGH: { reasoningEffort: "high" },
  MAXIMUM: { reasoningEffort: "max" },
  MED: { reasoningEffort: "medium" },
  MAX: { reasoningEffort: "max" },
};

function parseThinkingMode(modelName: string): { model: string; thinking: string | null } {
  const clean = (modelName || "").trim();
  if (!clean) return { model: modelName, thinking: null };

  // Bracket format: "deepseek-v4 [HI]" or "DeepSeek V4 [MX]"
  const m = clean.match(/^(.+?)\s+\[(LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX|LO|MD|HI|MX)\]\s*$/i);
  if (m) {
    const SHORT_MAP: Record<string, string> = { LO: "LOW", MD: "MEDIUM", HI: "HIGH", MX: "MAXIMUM", MED: "MEDIUM", MAX: "MAXIMUM" };
    const raw = m[2].toUpperCase();
    const tag = SHORT_MAP[raw] || raw;
    return { model: m[1].trim(), thinking: tag };
  }

  // Suffix format: "deepseek-v4-md", "deepseek-v4-lo", "deepseek-v4-hi", "deepseek-v4-mx"
  const suffixMatch = clean.match(/^(.+?)-(lo|md|hi|mx)$/i);
  if (suffixMatch) {
    const SUFFIX_MAP: Record<string, string> = { LO: "LOW", MD: "MEDIUM", HI: "HIGH", MX: "MAXIMUM" };
    const raw = suffixMatch[2].toUpperCase();
    return { model: suffixMatch[1].trim(), thinking: SUFFIX_MAP[raw] };
  }

  return { model: modelName, thinking: null };
}

export async function handleCopilot(req: HandlerInput): Promise<HandlerResult> {
  const { method, url, body, headers } = req;

  const host = headers["host"] || "";
  const isIndividual = host.includes("individual.githubcopilot.com");

  // POST /telemetry - Copilot telemetry (matches real response format)
  if (method === "POST" && (url === "/telemetry" || url.startsWith("/telemetry"))) {
    return { handled: true, response: jsonResponse({ itemsReceived: 1, itemsAccepted: 1, appId: null, errors: [] }) };
  }

  if (method === "GET" && url.includes("/mcp/")) {
    return { handled: true, response: jsonResponse({ servers: [], allow_all: true }) };
  }

  // GET /models - list all models
  if (method === "GET" && (url === "/models" || url.startsWith("/models?") || url === "/v1/models" || url.startsWith("/v1/models?"))) {
    await ensureModels();
    return { handled: true, response: jsonResponse({ data: FAKE_MODELS, object: "list" }) };
  }

  // GET /models/{id} or /models/{vendor}/{id} - get a specific model's capabilities
  const modelIdMatch = url.match(/\/(?:v1\/)?models\/([^?#]+)/);
  if (method === "GET" && modelIdMatch) {
    let modelId = modelIdMatch[1].replace(/\/$/, "");
    await ensureModels();
    let model = FAKE_MODELS.find((m: any) => m.id === modelId);
    if (!model && modelId.includes("/")) {
      // Try with just the short name (drop vendor prefix)
      const shortId = modelId.split("/").pop() || modelId;
      model = FAKE_MODELS.find((m: any) => m.id === shortId);
    }
    if (!model && modelId.startsWith("models/")) {
      // Handle double prefix: /models/openai/gpt-4o
      const parts = modelId.split("/");
      if (parts.length >= 2) {
        const shortId = parts[parts.length - 1];
        model = FAKE_MODELS.find((m: any) => m.id === shortId);
      }
    }
    if (model) {
      return { handled: true, response: jsonResponse(model) };
    }
    return { handled: true, response: jsonResponse({ error: "model not found", id: modelId }, 404) };
  }

  // POST /v1/messages - Anthropic Messages API (GHCP CLI, Copilot CLI, etc.)
  // Matches real Copilot SSE format from proxy capture:
  //   event: message_start / content_block_start / content_block_delta / message_stop
  if (method === "POST" && url === "/v1/messages") { trackRequest("copilot");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "gpt-4o";
    const messages = parsed.messages || [];
    const tools = parsed.tools || [];
    const isStream = parsed.stream === true;
    const maxTokens = parsed.max_tokens || 4096;

    // Body dedup: model + msg count + last user msg
    const _messages = parsed.messages || [];
    const _lastUMsg = _messages.filter((m: any) => m?.role === "user").pop();
    const _lastUContent = typeof _lastUMsg?.content === "string" ? _lastUMsg.content.slice(0, 100) : "";
    const _bdKey = `vm:${parsed.model || ""}:${_messages.length}:${_lastUContent}`;
    if ((RECENT_BODIES.get(_bdKey) ?? 0) && Date.now() - (RECENT_BODIES.get(_bdKey) ?? 0) < 30000) {
      RECENT_BODIES.set(_bdKey, Date.now());
      const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const toolId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: "task_complete", input: {} } })}\n\nevent: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`) } };
    }
    RECENT_BODIES.set(_bdKey, Date.now());

    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
      "claude-haiku-4.5": "", "gpt-5-mini": "", "gpt-4.1": "", "qwen3.5-plus": "",
    };
    await ensureModels();
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => m.id.startsWith("deepseek") && !m.id.includes("-embedding"))
        || FAKE_MODELS.find((m: any) => {
          const v = detectVendor(m.id);
          return !m.id?.includes("-embedding") && v !== "MiniMax" && v !== "Moonshot AI" && v !== "Zhipu AI" && v !== "Alibaba Cloud";
        });
      model = real?.id || model;
    }

    // ── Nag: drain or nag → task_complete (agentic mode only) ──
    const _copInitiator = headers["x-initiator"] || "";
    const _copAgentic = _copInitiator === "agent";
    const _copNagCount = _copAgentic ? countConsecutiveNags(messages) : 0;
    const _copDrain = _copAgentic && (RECENT_BODIES.get(model) ?? 0) && Date.now() - (RECENT_BODIES.get(model) ?? 0) < 20000;
    if (_copDrain || _copNagCount > 0) {
      RECENTLY_COMPLETED.set(model, Date.now());
      stripNagMessages(messages);
      const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const toolId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const msgStart = JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      const blockStart = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: "task_complete", input: {} } });
      const blockStop = JSON.stringify({ type: "content_block_stop", index: 0 });
      const msgDelta = JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } });
      const msgStop = JSON.stringify({ type: "message_stop" });
      const sse = `event: message_start\ndata: ${msgStart}\n\nevent: content_block_start\ndata: ${blockStart}\n\nevent: content_block_stop\ndata: ${blockStop}\n\nevent: message_delta\ndata: ${msgDelta}\n\nevent: message_stop\ndata: ${msgStop}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    const queryPreview = lastUserMsg ? safePreviewFromContent(lastUserMsg.content) : "";
    const tag = agentTag(headers);
    const provider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";
    const completeLog = reqLog({ tag, provider, model, preview: queryPreview, body: parsed });
    const startTime = Date.now();

    const getContent = (msgs: any[]): string =>
      msgs.map((m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : "").filter(Boolean).join("\n") || "Hello";

    // Write an SSE event with event: + data: lines matching real Copilot format
    const sseEvent = (sock: any, event: string, data: any) => {
      if (sock.destroyed || sock.closed) return;
      sock.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Helper to emit a full Anthropic Messages API SSE stream
    // Emits: thinking block → text block → optional tool_use blocks → message_done
    const writeMessageStream = (sock: any, msgId: string, text: string, toolBlocks?: any | any[]) => {
      let nextIdx = 0;
      sseEvent(sock, "message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant",
          content: [],
          model, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      // Thinking block (matches real API — Claude always sends a thinking block)
      sseEvent(sock, "content_block_start", {
        type: "content_block_start", index: nextIdx,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: nextIdx });
      nextIdx++;
      // Text block
      sseEvent(sock, "content_block_start", {
        type: "content_block_start", index: nextIdx,
        content_block: { type: "text", text: "" },
      });
      const chunks = text.match(/.{1,64}/g) || [text || ""];
      for (const chunk of chunks) {
        if (sock.destroyed || sock.closed) break;
        sseEvent(sock, "content_block_delta", {
          type: "content_block_delta", index: nextIdx,
          delta: { type: "text_delta", text: chunk },
        });
      }
      sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: nextIdx });
      nextIdx++;
      // Optional tool_use blocks
      const blocks = toolBlocks ? (Array.isArray(toolBlocks) ? toolBlocks : [toolBlocks]) : [];
      for (const tb of blocks) {
        sseEvent(sock, "content_block_start", {
          type: "content_block_start", index: nextIdx,
          content_block: { type: "tool_use", id: tb.id || `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, name: tb.name, input: tb.input },
        });
        sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: nextIdx });
        nextIdx++;
      }
      sseEvent(sock, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: blocks.length ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: text.length + (blocks.length ? 50 : 0) },
      });
      sseEvent(sock, "message_stop", { type: "message_stop" });
    };

    try {
      // ── Native UMANS Anthropic pass-through ───────────────────────────
      // UMANS upstream natively supports /messages, so skip the anthropic-bridge
      // and forward the Anthropic payload directly when the routed model is UMANS.
      if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") {
        const resp = await umansAnthropicChat(parsed);
        const respCt = resp.headers.get("content-type") || (isStream ? "text/event-stream" : "application/json");
        console.log(`[COPILOT /v1/messages] native-umans req=${model} status=${resp.status} ct=${respCt}`);
        if (resp.status >= 400) {
          const errText = await resp.text().catch(() => "");
          const errMsg = errText.length > 500 ? errText.slice(0, 500) + "..." : errText;
          const errId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          const errSse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: errId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
          if (completeLog) completeLog(Date.now() - startTime);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(errSse) } };
        }
        if (completeLog) completeLog(Date.now() - startTime);
        const buf = Buffer.from(await resp.arrayBuffer());
        return { handled: true, response: { statusCode: resp.status, headers: { "content-type": respCt, "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: buf } };
      }

      const bridge = anthropicToOpenAIRequest(parsed);
      injectIdentity(bridge.messages, getModelDisplayName(parsed.model || model), parsed.model || model);
      const scrubbed1 = scrubTaskComplete(bridge.messages, bridge.tools);
      bridge.messages = scrubbed1.messages;
      bridge.tools = scrubbed1.tools;
      bridge.tools = compressToolDefinitions(bridge.tools);
    const resp = await routeChat(bridge.model, bridge.messages, bridge.tools, false, { max_tokens: bridge.max_tokens, ...parsed });
      const ct = resp.headers.get("content-type") || "";
      let content = "";
      let toolCalls: any[] | undefined;
      if (ct.includes("text/event-stream")) {
        const streamLog = new StreamResponseLogger({ endpoint: "/v1/messages", model: bridge.model, resolved: bridge.model, status: resp.status });
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        const toolCallAccum: Record<number, any> = {};
        let reasoningAccum = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value, { stream: true }).split("\n")) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              try {
                const d = JSON.parse(t.slice(6));
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) { content += delta.content; streamLog.addContent(delta.content); }
                if (delta?.reasoning_content) { reasoningAccum += delta.reasoning_content; streamLog.addReasoning(delta.reasoning_content); }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                    if (tc.id) toolCallAccum[idx].id = tc.id;
                    // Recover name from ID when the LLM embeds it in the
                    // tool_call ID (`functions.<name>:N`) instead of
                    // `function.name` (Kimi K2.7, Qwen 3.6, Agnes).
                    // Set-once: LLMs repeat the full name per delta, so
                    // appending would corrupt it to "foofoofoo".
                    const recoveredName = tc.function?.name || extractNameFromToolId(tc.id);
                    if (recoveredName && !toolCallAccum[idx].function.name) {
                      toolCallAccum[idx].function.name = recoveredName;
                    }
                    if (tc.function?.arguments) toolCallAccum[idx].function.arguments += tc.function.arguments;
                    streamLog.addToolCall(idx, tc.id || "", tc.function?.name || extractNameFromToolId(tc.id) || "", tc.function?.arguments || "");
                  }
                }
                if (d.choices?.[0]?.finish_reason) streamLog.setFinishReason(d.choices[0].finish_reason);
                if (d.usage) streamLog.setUsage(d.usage);
              } catch {}
            }
          }
        }
        const keys = Object.keys(toolCallAccum);
        if (keys.length) toolCalls = keys.map((k) => toolCallAccum[+k]);
        content = stripCopilotGreeting(content);
        if (reasoningAccum) storeReasoning(content, reasoningAccum);
        streamLog.flush();
      } else {
        const data: any = await resp.json();
        const msg = data.choices?.[0]?.message;
        content = stripCopilotGreeting(msg?.content || "");
        if (msg?.tool_calls?.length) toolCalls = msg.tool_calls;
      }
      const elapsed = Date.now() - startTime;
      if (completeLog) completeLog(elapsed);

      // ── Tool salvager (non-VS copilot-handler) ──
      // Repair upstream tool_calls, detect apology text, detect tool loops.
      // When ALL tool calls are unrecoverable AND we see an apology or loop,
      // fall back to a clean task_complete tool_use so VS stops waiting.
      if (toolCalls?.length) {
        const { repaired, dropped } = repairToolCalls(toolCalls);
        if (repaired.length || dropped.length) {
          if (repaired.length !== toolCalls.length || dropped.length) {
            console.log(`[TOOL SALVAGE] ${bridge.model}: ${repaired.length}/${toolCalls.length} tool_calls repaired, ${dropped.length} dropped`);
          }
        }
        const allDropped = toolCalls.length > 0 && repaired.length === 0;
        const isApology = detectApologyText(content);
        const isLoop = repaired.length
          ? detectToolLoop(bridge.messages, {
              name: repaired[0].function?.name || "",
              arguments: repaired[0].function?.arguments || "{}",
            })
          : { inLoop: false, count: 0, tool: "", args: "" };
        if ((isApology && allDropped) || isLoop.inLoop) {
          bumpSalvageStat(isLoop.inLoop ? "loopInjected" : "apologyInjected");
          console.log(`[TOOL SALVAGE] ${bridge.model}: ${isLoop.inLoop ? `loop(${isLoop.tool}×${isLoop.count})` : "apology"} → task_complete`);
          toolCalls = [{
            id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
            type: "function",
            function: { name: "task_complete", arguments: "{}" },
          }];
        } else {
          toolCalls = repaired;
        }
      } else if (detectApologyText(content)) {
        // No tool calls, but the model apologized — also synthesize task_complete
        // so VS doesn't see a stuck "I can't" text response.
        bumpSalvageStat("apologyInjected");
        console.log(`[TOOL SALVAGE] ${bridge.model}: pure apology text → task_complete`);
        toolCalls = [{
          id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
          type: "function",
          function: { name: "task_complete", arguments: "{}" },
        }];
      }

      // Convert upstream OpenAI tool_calls → Anthropic tool_use content blocks
      const openAIToCalls = (tc: any) => {
        const fn = tc.function || tc;
        let args: any = {};
        try { args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}"); } catch {}
        return { type: "tool_use", id: normalizeToolCallId(tc.id, "anthropic"), name: fn.name || extractNameFromToolId(tc.id) || "unknown", input: args };
      };
      const upstreamToolBlocks = toolCalls?.length ? toolCalls.map(openAIToCalls) : [];

      // Detect file creation and generate tool_use (only if upstream didn't return tool_calls)
      const userContent = getContent(messages);
      const filename = extractFilename(userContent);
      let toolUse: { name: string; input: any } | undefined;
      let responseText = content || generateCopilotCompletion(userContent, model);

      if (!upstreamToolBlocks.length && filename && (userContent.toLowerCase().includes("create") || userContent.toLowerCase().includes("write") || userContent.toLowerCase().includes("make"))) {
        const fileContent = filename.endsWith(".css") ? generateCSSContent(filename) :
                           filename.endsWith(".py") ? generatePyContent(filename) :
                           generateJSContent(filename);
        toolUse = { name: "write_file", input: { path: filename, content: fileContent } };
        responseText = content || `I'll create ${filename} for you.`;
      }

      const allToolBlocks = upstreamToolBlocks.length ? upstreamToolBlocks : (toolUse ? [{ type: "tool_use", id: `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, name: toolUse.name, input: toolUse.input }] : []);
      const stopReason = allToolBlocks.length ? "tool_use" : "end_turn";

      if (!isStream) {
        const contentBlocks: any[] = [{ type: "text", text: responseText }];
        contentBlocks.push(...allToolBlocks);
        return {
          handled: true,
          response: jsonResponse({
            id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
            type: "message", role: "assistant",
            content: contentBlocks,
            model: parsed.model || model,
            stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: responseText.length + (allToolBlocks.length ? 50 : 0) },
          }),
        };
      }

      const sock = req.clientSocket;
      if (!sock) {
        return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
      }
      const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const head = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
      sock.write(head);
      writeMessageStream(sock, msgId, responseText, allToolBlocks);
      sock.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    } catch (e: any) {
      console.log(`\n[MOCK V1/MESSAGES] ${e.message} — using local mock`);
      const userContent = getContent(messages);
      const filename = extractFilename(userContent);
      let mockToolUse: { name: string; input: any } | undefined;
      let mockText = generateCopilotCompletion(userContent, model);
      
      if (filename && (userContent.toLowerCase().includes("create") || userContent.toLowerCase().includes("write") || userContent.toLowerCase().includes("make"))) {
        const fileContent = filename.endsWith(".css") ? generateCSSContent(filename) :
                           filename.endsWith(".py") ? generatePyContent(filename) :
                           generateJSContent(filename);
        mockToolUse = { name: "write_file", input: { path: filename, content: fileContent } };
        mockText = `I'll create ${filename} for you.`;
      }

      const mockBlocks = mockToolUse ? [{ type: "tool_use", id: `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, name: mockToolUse.name, input: mockToolUse.input }] : [];
      const mockStopReason = mockBlocks.length ? "tool_use" : "end_turn";
      
      const errElapsed = Date.now() - startTime;
      if (completeLog) completeLog(errElapsed);

      if (!isStream) {
        const contentBlocks: any[] = [{ type: "text", text: mockText }];
        contentBlocks.push(...mockBlocks);
        return {
          handled: true,
          response: jsonResponse({
            id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
            type: "message", role: "assistant",
            content: contentBlocks,
            model: parsed.model || model,
            stop_reason: mockStopReason, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: mockText.length + (mockBlocks.length ? 50 : 0) },
          }),
        };
      }

      const sock = req.clientSocket;
      if (!sock) {
        return { handled: true, response: jsonResponse({ error: "no socket", mock: mockText }, 500) };
      }
      const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const head = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
      sock.write(head);
      writeMessageStream(sock, msgId, mockText, mockBlocks);
      sock.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    }
  }
  // POST /v1/chat/completions - forward to opencode API

  if (method === "POST" && url.includes("/chat/completions") && !url.includes("/agents/")) { trackRequest("copilot");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}

    // NES ghost text detection: model names like copilot-nes-oct / gpt-41-copilot
    const rawModel = parsed.model || "";
    const isGhostText = rawModel.includes("copilot-nes") || rawModel.includes("gpt-41-copilot") || headers["openai-intent"] === "copilot-ghost";
    if (isGhostText) {
      const useSupermaven = isSupermavenEnabled() && isSupermavenReady();
      const tag = agentTag(headers);

      // Extract prompt from NES message format (user message content)
      let prompt = "";
      for (const msg of (parsed.messages || [])) {
        if (msg.role === "user" && typeof msg.content === "string") {
          prompt = msg.content;
          break;
        }
      }
      // Look for code_to_edit block with cursor
      const ceMatch = prompt.match(/<\|code_to_edit\|>([\s\S]*?)<\|cursor\|>/);
      if (ceMatch) prompt = ceMatch[1].trim();

      let completion = "";

      if (useSupermaven) {
        console.log(`[SUPERMAVEN] ${tag} ghost text: "${prompt.substring(0, 80)}..."`);
        try {
          completion = await supermavenCodeComplete(prompt);
          console.log(`[SUPERMAVEN] ${tag} result: "${completion.substring(0, 80)}"`);
        } catch (e: any) {
          console.log(`[SUPERMAVEN] ${tag} error: ${e.message}`);
        }
      }

      if (!completion) {
        completion = prompt;
      }

      const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      const created = Math.floor(Date.now() / 1000);
      const sse = `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${rawModel}","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\ndata: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${rawModel}","choices":[{"index":0,"delta":{"content":${JSON.stringify(completion)}},"finish_reason":null}]}\n\ndata: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${rawModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n`;
      const sock = req.clientSocket;
      if (sock) {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
        sock.write(sse); sock.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }

    await ensureModels();
    let rawModel2 = parsed.model || "";
    const isStream = parsed.stream === true;
    const messages = parsed.messages || [];
    const tools = parsed.tools || [];

    // Strip thinking tag from model name and apply reasoningEffort
    const parsedTag = parseThinkingMode(rawModel2);
    let model = parsedTag.model;
    if (parsedTag.thinking) {
      const params = THINKING_TAG_PARAMS[parsedTag.thinking];
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (parsed[k] === undefined) parsed[k] = v;
        }
      }
    }

    // Map common VS/Copilot model names to real opencode models
    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
      "claude-haiku-4.5": "", "gpt-5-mini": "", "gpt-4.1": "", "qwen3.5-plus": "",
    };
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => m.id.startsWith("deepseek") && !m.id.includes("-embedding"))
        || FAKE_MODELS.find((m: any) => {
          const v = detectVendor(m.id);
          return !m.id?.includes("-embedding") && v !== "MiniMax" && v !== "Moonshot AI" && v !== "Zhipu AI" && v !== "Alibaba Cloud";
        });
      model = real?.id || model;
      console.log(`\n[MODEL] Aliased ${rawModel2} → ${model}`);
    }

    // If still not in model list, pick any non-MiniMax model
    if (!FAKE_MODELS.find((m: any) => m.id === model) && !isProviderRouted(model)) {
      const origModel = model;
      if (!model && _lastRealModel) {
        model = _lastRealModel;
      } else {
        const real = FAKE_MODELS.find((m: any) => m.id.startsWith("deepseek") && !m.id.includes("-embedding"))
          || FAKE_MODELS.find((m: any) => {
            const v = detectVendor(m.id);
            return !m.id?.includes("-embedding") && v !== "MiniMax" && v !== "Moonshot AI" && v !== "Zhipu AI" && v !== "Alibaba Cloud";
          });
        model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      }
      console.log(`\n[MODEL] ${origModel || "(empty)"} not found, picked ${model}`);
    }
    if (!messages.length) {
      messages.push({ role: "user", content: "Hello" });
    }

    injectIdentity(messages, getModelDisplayName(rawModel2), rawModel2);
    _lastRealModel = model;

    // ── Nag: any nag or retry within 20s → task_complete (agentic mode only) ──
    const _chatCopInitiator = headers["x-initiator"] || "";
    const _chatCopAgentic = _chatCopInitiator === "agent";
    const _chatCopNagCount = _chatCopAgentic ? countConsecutiveNags(messages) : 0;
    const _chatCopDrain = _chatCopAgentic && (RECENTLY_COMPLETED.get(model) ?? 0) && Date.now() - (RECENTLY_COMPLETED.get(model) ?? 0) < 20000;
    if (_chatCopNagCount > 0 || _chatCopDrain) {
      RECENTLY_COMPLETED.set(model, Date.now());
      stripNagMessages(messages);
      const _callId = `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      const _id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      const _created = Math.floor(Date.now() / 1000);
      const sse = `data: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\ndata: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"${_callId}","type":"function","function":{"name":"task_complete","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`;
      const sock = req.clientSocket;
      if (sock) {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
        sock.write(sse); sock.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }


    const _initiator = headers["x-initiator"] || "";
    _lastUserContent = _initiator !== "agent" ? extractUserPrompt(messages) : _lastUserContent;

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    const chatPreview = lastUserMsg ? safePreviewFromContent(lastUserMsg.content) : "";
    const tag = agentTag(headers);
    const provider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";
    const completeLog = reqLog({ tag, provider, model, preview: chatPreview, body: parsed });
    const startTime = Date.now();

    const session = detectSessionSignal(messages);
    if (session) {
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      console.log(`[COPILOT SESSION] ${ts} [Session#${session.sessNum}>${session.keyLabel}] ${model} "${extractUserPrompt(messages).substring(0, 120)}"`);
    }

    try {
      const scrubbed2 = scrubTaskComplete(messages, tools);
      const cleanMsgs2 = scrubbed2.messages;
      const cleanTools2 = scrubbed2.tools;
      const cleanTools2Compressed = compressToolDefinitions(cleanTools2);
      const resp = await routeChat(model, cleanMsgs2, cleanTools2, isStream, parsed, session);

      if (!isStream) {
        const data: any = await resp.json();
        if (completeLog) completeLog(Date.now() - startTime);
        return { handled: true, response: jsonResponse(data) };
      }

      // Streaming: write SSE chunks directly to client socket
      const ct = resp.headers.get("content-type") || "";
      const actualStream = isStream && ct.includes("text/event-stream");
      if (!actualStream && !resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Copilot upstream ${resp.status}: ${txt.slice(0, 300)}`);
      }
      const sock = req.clientSocket;
      if (sock) {
        if (!actualStream) {
          const data: any = await resp.json().catch(() => ({}));
          const msg = data.choices?.[0]?.message || {};
          const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          const stopReason = msg.tool_calls?.length ? "tool_use" : "end_turn";
          const usage = data.usage || {};
          if (usage.output_tokens === undefined) usage.output_tokens = 0;
          if (usage.input_tokens === undefined) usage.input_tokens = 0;
          const sseChunks: string[] = [];
          sseChunks.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } })}\n\n`);
          if (msg.content) {
            sseChunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: msg.content } })}\n\n`);
            sseChunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
          }
          if (msg.tool_calls?.length) {
            msg.tool_calls.forEach((tc: any, i: number) => {
              const fn = tc.function || tc;
              const safeToolId = normalizeToolCallId(tc.id, "anthropic");
              sseChunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: msg.content ? i + 1 : i, content_block: { type: "tool_use", id: safeToolId, name: fn.name || extractNameFromToolId(tc.id) || "unknown", input: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments || {} } })}\n\n`);
              sseChunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: msg.content ? i + 1 : i })}\n\n`);
            });
          }
          sseChunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } })}\n\n`);
          sseChunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
          sock.write(respHead);
          sock.write(sseChunks.join(""));
          sock.end();
          if (completeLog) completeLog(Date.now() - startTime);
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-request-id: req-${forge.util.bytesToHex(forge.random.getBytesSync(6))}\r\nconnection: close\r\n\r\n`;
        sock.write(respHead);

        const streamLog = new StreamResponseLogger({ endpoint: "/v1/chat/completions", model, resolved: model, status: resp.status });
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let reasoningAccum = "";
        let lastAssistantContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          sock.write(chunk);
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              try {
                const d = JSON.parse(t.slice(6));
                const delta = d.choices?.[0]?.delta;
                if (delta?.reasoning_content) {
                  reasoningAccum += delta.reasoning_content;
                  streamLog.addReasoning(delta.reasoning_content);
                }
                if (delta?.content) {
                  lastAssistantContent += delta.content;
                  streamLog.addContent(delta.content);
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    streamLog.addToolCall(idx, tc.id || "", tc.function?.name || extractNameFromToolId(tc.id) || "", tc.function?.arguments || "");
                  }
                }
                if (d.choices?.[0]?.finish_reason) streamLog.setFinishReason(d.choices[0].finish_reason);
                if (d.usage) streamLog.setUsage(d.usage);
              } catch {}
            }
          }
        }
        if (reasoningAccum) {
          console.log(`\n[REASONING CACHE] content_len=${lastAssistantContent.length} reasoning_len=${reasoningAccum.length} key=${lastAssistantContent.slice(0, 60)}`);
          storeReasoning(lastAssistantContent, reasoningAccum);
        }
        sock.end();
        if (completeLog) completeLog(Date.now() - startTime);
        streamLog.flush();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      // Fallback: collect into buffer
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sse = "";
      let fallbackBuf = "";
      let fallbackReasoning = "";
      let fallbackContent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sse += chunk;
        fallbackBuf += chunk;
        const lines = fallbackBuf.split("\n");
        fallbackBuf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("data: ") && t !== "data: [DONE]") {
            try {
              const d = JSON.parse(t.slice(6));
              const delta = d.choices?.[0]?.delta;
              if (delta?.reasoning_content) fallbackReasoning += delta.reasoning_content;
              if (delta?.content) fallbackContent += delta.content;
            } catch {}
          }
        }
      }
      if (fallbackReasoning) storeReasoning(fallbackContent, fallbackReasoning);
      if (completeLog) completeLog(Date.now() - startTime);
      return {
        handled: true,
        response: {
          statusCode: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "x-accel-buffering": "no",
          },
          body: Buffer.from(sse),
        },
      };
    } catch (e: any) {
      if (completeLog) completeLog(Date.now() - startTime);
      // Fallback to local mock when upstream fails
      console.log(`\n[MOCK FALLBACK] ${e.message} — using local mock response`);
      const mockContent = generateCopilotCompletion(messages.map((m: any) => m.content || "").filter(Boolean).join("\n") || "Hello", model);
      if (isStream) {
        const sock = req.clientSocket;
        if (sock) {
          const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`;
          sock.write(respHead);
          sock.write(generateStreamingResponse(mockContent, model));
          sock.end();
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
      }
      return { handled: true, response: jsonResponse({
        id: `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model, choices: [{ index: 0, message: { role: "assistant", content: mockContent, refusal: null }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })};
    }
  }

  // POST /agents/sessions - create a new agent session (real format: {id, agent_task_id, task_id})
  if (method === "POST" && url.match(/\/agents\/sessions(\?|$)/)) {
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const agentTaskId = parsed.agent_task_id || `agent-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
    const id = `sess-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
    // Store minimal session tracking
    chatSessions.set(id, { id, agent_task_id: agentTaskId, task_id: `task-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, model: parsed.model || "gpt-4o", created_at: Math.floor(Date.now() / 1000), messages: [], state: { thread: [], turn_id: 0 } });
    const session = chatSessions.get(id)!;
    return { handled: true, response: { statusCode: 201, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" }, body: Buffer.from(JSON.stringify({ id: session.id, agent_task_id: session.agent_task_id, task_id: session.task_id })) } };
  }

  // GET /agents/sessions/{id} - get session state
  if (method === "GET" && url.match(/\/agents\/sessions\/[^/]+$/)) {
    const sessionId = url.split("/agents/sessions/")[1]?.split(/[?#]/)[0] || "";
    const session = chatSessions.get(sessionId);
    if (!session) {
      return { handled: true, response: jsonResponse({ error: "session not found", id: sessionId }, 404) };
    }
    return { handled: true, response: jsonResponse(session) };
  }

  // DELETE /agents/sessions/{id} - delete session
  if (method === "DELETE" && url.match(/\/agents\/sessions\/[^/]+$/)) {
    const sessionId = url.split("/agents/sessions/")[1]?.split(/[?#]/)[0] || "";
    chatSessions.delete(sessionId);
    return { handled: true, response: jsonResponse({ ok: true }) };
  }

  // POST /agents/sessions/{id} - poll/update session state (GHCP sends this to check session)
  if (method === "POST" && url.match(/\/agents\/sessions\/[^/]+$/)) {
    const sessionId = url.split("/agents/sessions/")[1]?.split(/[?#]/)[0] || "";
    let session = chatSessions.get(sessionId);
    if (!session) session = createSession();
    return { handled: true, response: jsonResponse(session) };
  }
  // POST /agents/sessions/{id}/messages - send message to session

  if (method === "POST" && url.match(/\/agents\/sessions\/[^/]+\/messages/)) { trackRequest("copilot");
    const sessionId = url.split("/agents/sessions/")[1]?.split("/")[0] || "";
    let session = chatSessions.get(sessionId);
    if (!session) session = createSession();

    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}

    const userMsg = parsed.content || parsed.message || "";
    const stream = parsed.stream === true;
    const userMessages = parsed.messages || [];

    const model = session.model;
    const latestContent = userMessages.length > 0
      ? userMessages[userMessages.length - 1]?.content || userMsg
      : userMsg;
    const responseContent = generateCopilotCompletion(latestContent || "Hello", model);

    if (stream) {
      return {
        handled: true,
        response: {
          statusCode: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "x-accel-buffering": "no",
          },
          body: Buffer.from(generateStreamingResponse(responseContent, model)),
        },
      };
    }

    session.state.turn_id = (session.state.turn_id || 0) + 1;
    const now = Math.floor(Date.now() / 1000);

    for (const msg of userMessages) {
      session.messages.push({
        ...msg,
        role: "user",
        created_at: msg.created_at || now,
      });
    }

    if (!userMessages.length && userMsg) {
      session.messages.push({ role: "user", content: userMsg, created_at: now });
    }

    const reply = {
      role: "assistant",
      content: responseContent,
      created_at: now + 1,
      turn_id: session.state.turn_id,
    };
    session.messages.push(reply);

    return {
      handled: true,
      response: jsonResponse({
        session_id: session.id,
        messages: [reply],
        state: session.state,
      }),
    };
  }

  // GET /agents/sessions/{id}/messages - get messages for session
  if (method === "GET" && url.match(/\/agents\/sessions\/[^/]+\/messages/)) {
    const sessionId = url.split("/agents/sessions/")[1]?.split("/")[0] || "";
    const session = chatSessions.get(sessionId);
    if (!session) {
      return { handled: true, response: jsonResponse({ messages: [] }) };
    }
    return { handled: true, response: jsonResponse({ messages: session.messages }) };
  }

  // POST /agents/sessions/{id}/events - poll session events (returns 201 with empty body)
  if ((method === "POST" || method === "GET") && url.match(/\/agents\/sessions\/[^/]+\/events/)) {
    return { handled: true, response: { statusCode: 201, headers: { "content-length": "0", "content-type": "application/json" }, body: Buffer.alloc(0) } };
  }

  // POST /responses - OpenAI Responses API (Copilot CLI agent mode)
  if (method === "POST" && (url === "/responses" || url.startsWith("/responses?"))) {
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const input = parsed.input || "";
    const instructions = parsed.instructions || "";
    const tools = parsed.tools || [];
    const isStream = parsed.stream === true;

    const userContent = typeof input === "string" ? input :
      Array.isArray(input) ? input.map((m: any) => safePreviewFromContent(m.content) || safePreviewFromContent(m) || "").join("\n") : "Hello";

    await ensureModels();
    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
      "claude-haiku-4.5": "", "gpt-5-mini": "", "gpt-4.1": "", "qwen3.5-plus": "",
    };
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => m.id.startsWith("deepseek") && !m.id.includes("-embedding"))
        || FAKE_MODELS.find((m: any) => {
          const v = detectVendor(m.id);
          return !m.id?.includes("-embedding") && v !== "MiniMax" && v !== "Moonshot AI" && v !== "Zhipu AI" && v !== "Alibaba Cloud";
        });
      model = real?.id || model;
    }
    if (!FAKE_MODELS.find((m: any) => m.id === model) && !isProviderRouted(model)) {
      const origModel = model;
      if (!model && _lastRealModel) {
        model = _lastRealModel;
      } else {
        const real = FAKE_MODELS.find((m: any) => m.id.startsWith("deepseek") && !m.id.includes("-embedding"))
          || FAKE_MODELS.find((m: any) => {
            const v = detectVendor(m.id);
            return !m.id?.includes("-embedding") && v !== "MiniMax" && v !== "Moonshot AI" && v !== "Zhipu AI" && v !== "Alibaba Cloud";
          });
        model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      }
      console.log(`[MODEL] ${origModel || "(empty)"} not found, picked ${model}`);
    }
    _lastRealModel = model;

    const messages = [
      ...(instructions ? [{ role: "system", content: instructions }] : []),
      { role: "user", content: userContent },
    ];

    const tag = agentTag(headers);
    const provider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";
    const completeLog = reqLog({ tag, provider, model, preview: userContent, body: parsed });
    const startTime = Date.now();

    try {
      const scrubbed3 = scrubTaskComplete(messages, tools);
      const cleanMsgs3 = scrubbed3.messages;
      const cleanTools3 = scrubbed3.tools;
      const cleanTools3Compressed = compressToolDefinitions(cleanTools3);
      const resp = await routeChat(model, cleanMsgs3, cleanTools3Compressed, isStream, { ...parsed });

      if (!isStream) {
        const ct = resp.headers.get("content-type") || "";
        let data: any;
        if (ct.includes("text/event-stream")) {
          const reader = resp.body!.getReader();
          const decoder = new TextDecoder();
          let fullContent = "";
          const toolCallAccum: Record<number, any> = {};
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split("\n")) {
              const t = line.trim();
              if (t.startsWith("data: ") && t !== "data: [DONE]") {
                try {
                  const d = JSON.parse(t.slice(6));
                  const delta = d.choices?.[0]?.delta;
                  if (delta?.content) fullContent += delta.content;
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                      if (tc.id) toolCallAccum[idx].id = tc.id;
                      if (tc.function?.name) toolCallAccum[idx].function.name += tc.function.name;
                      if (tc.function?.arguments) toolCallAccum[idx].function.arguments += tc.function.arguments;
                    }
                  }
                } catch {}
              }
            }
          }
          const msg: any = { content: stripCopilotGreeting(fullContent) };
          const keys = Object.keys(toolCallAccum);
          if (keys.length) msg.tool_calls = keys.map((k) => toolCallAccum[+k]);
          data = { choices: [{ message: msg }], usage: { completion_tokens: fullContent.length } };
        } else {
          data = await resp.json();
          if (data?.choices?.[0]?.message?.content) {
            data.choices[0].message.content = stripCopilotGreeting(data.choices[0].message.content);
          }
        }
        const elapsed = Date.now() - startTime;
        if (completeLog) completeLog(elapsed);

        // Build output items: text message + tool call items
        const msg = data.choices?.[0]?.message || {};

        // ── Tool salvager (responses non-stream streaming accumulation path) ──
        if (msg.tool_calls?.length) {
          const { repaired, dropped } = repairToolCalls(msg.tool_calls);
          const allDropped = msg.tool_calls.length > 0 && repaired.length === 0;
          const isApology = detectApologyText(msg.content || "");
          const isLoop = repaired.length
            ? detectToolLoop(messages, { name: repaired[0].function?.name || "", arguments: repaired[0].function?.arguments || "{}" })
            : { inLoop: false, count: 0, tool: "", args: "" };
          if ((isApology && allDropped) || isLoop.inLoop) {
            bumpSalvageStat(isLoop.inLoop ? "loopInjected" : "apologyInjected");
            console.log(`[TOOL SALVAGE] ${model}: ${isLoop.inLoop ? `loop(${isLoop.tool}×${isLoop.count})` : "apology"} → task_complete`);
            msg.tool_calls = [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }];
          } else {
            const originalLen = msg.tool_calls.length;
            msg.tool_calls = repaired;
            if (repaired.length !== originalLen || dropped.length) {
              console.log(`[TOOL SALVAGE] ${model}: ${repaired.length}/${originalLen} tool_calls repaired, ${dropped.length} dropped`);
            }
          }
        } else if (detectApologyText(msg.content || "")) {
          bumpSalvageStat("apologyInjected");
          console.log(`[TOOL SALVAGE] ${model}: pure apology text → task_complete`);
          msg.tool_calls = [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }];
        }

        // Build output items: text message + tool call items
        const output: any[] = [{
          type: "message",
          id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
          role: "assistant",
          content: [{ type: "output_text", text: msg.content || "" }],
        }];
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function || tc;
            const safeCallId = normalizeToolCallId(tc.id, "openai");
            output.push({
              type: "function_call",
              id: safeCallId,
              status: "completed",
              name: fn.name || extractNameFromToolId(tc.id) || "unknown",
              call_id: safeCallId,
              arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
            });
          }
        }
        return { handled: true, response: jsonResponse({
          id: `resp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model, instructions,
          output,
          usage: data.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        })};
      }

      const sock = req.clientSocket;
      if (sock) {
        const respCt = resp.headers.get("content-type") || "";
        const actualStream = isStream && respCt.includes("text/event-stream");
        if (!actualStream) {
          const data: any = await resp.json().catch(() => ({}));
          const respId = `resp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          const head = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
          sock.write(head);
          sock.write(`event: response.created\ndata: ${JSON.stringify({ response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model, instructions, status: "completed", incomplete_details: null, output: [], usage: data.usage || null } })}\n\n`);
          const msg = data.choices?.[0]?.message || {};
          let outIdx = 0;
          if (msg.content) {
            sock.write(`event: response.output_item.added\ndata: ${JSON.stringify({ response_id: respId, output_index: outIdx, item: { id: msgId, type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }], status: "completed" } })}\n\n`);
            outIdx++;
          }
          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              const fn = tc.function || tc;
              const callId = normalizeToolCallId(tc.id, "openai");
              const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
              sock.write(`event: response.output_item.added\ndata: ${JSON.stringify({ response_id: respId, output_index: outIdx, item: { id: callId, type: "function_call", status: "completed", name: fn.name || extractNameFromToolId(tc.id) || "unknown", arguments: args, call_id: callId } })}\n\n`);
              outIdx++;
            }
          }
          sock.write(`event: response.done\ndata: ${JSON.stringify({ response_id: respId })}\n\n`);
          sock.end();
          if (completeLog) completeLog(Date.now() - startTime);
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
        const respId = `resp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const head = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-quota-snapshot-chat: ent=500&ov=0.0&ovPerm=false&rem=58.0&rst=${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString()}&totRem=290.0\r\nx-quota-snapshot-completions: ent=4000&ov=0.0&ovPerm=false&rem=58.0&rst=${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString()}&totRem=2320.0\r\nconnection: close\r\n\r\n`;
        sock.write(head);

        sock.write(`event: response.created\ndata: ${JSON.stringify({ response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model, instructions, status: "in_progress", incomplete_details: null, output: [], usage: null } })}\n\n`);
        let outputIndex = 0;
        sock.write(`event: response.output_item.added\ndata: ${JSON.stringify({ response_id: respId, output_index: outputIndex, item: { id: msgId, type: "message", role: "assistant", content: [], status: "in_progress" } })}\n\n`);
        sock.write(`event: response.content_part.added\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: "text", text: "" } })}\n\n`);

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        const toolCallAccum: Record<number, { id: string; name: string; args: string; ouputIndex: number }> = {};
        let nextToolOutputIdx = 1;
        let gBuf = "";
        let gDone = false;
        const streamLog = new StreamResponseLogger({ endpoint: "/responses", model, resolved: model, status: resp.status });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              try {
                const d = JSON.parse(t.slice(6));
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) {
                  streamLog.addContent(delta.content);
                  if (!gDone) {
                    gBuf += delta.content;
                    const s = stripCopilotGreeting(gBuf);
                    const finishReason = d.choices?.[0]?.finish_reason;
                    // Flush greeting buffer when: greeting matched, buffer exceeds
                    // 200 chars, OR the upstream signaled completion (short
                    // single-chunk responses from agnes/bitnet/etc. would
                    // otherwise be trapped in gBuf and never forwarded).
                    if (s.length !== gBuf.length || gBuf.length >= 200 || finishReason) {
                      gDone = true;
                      if (s.length > 0) {
                        fullContent += s;
                        sock.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, delta: s })}\n\n`);
                      }
                    }
                  } else {
                    fullContent += delta.content;
                    sock.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, delta: delta.content })}\n\n`);
                  }
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccum[idx]) {
                      const safeId = normalizeToolCallId(tc.id, "openai");
                      toolCallAccum[idx] = { id: safeId, name: "", args: "", ouputIndex: nextToolOutputIdx++ };
                    }
                    // Recover name from ID when the LLM embeds it in the
                    // tool_call ID (`functions.<name>:N`) instead of the
                    // `function.name` field (Kimi K2.7, Qwen 3.6, Agnes).
                    // LLMs often repeat the full tool name in every delta —
                    // set-once (don't append) to avoid "foofoofoo" corruption.
                    const recoveredName = tc.function?.name || extractNameFromToolId(tc.id);
                    if (recoveredName && !toolCallAccum[idx].name) {
                      toolCallAccum[idx].name = recoveredName;
                    }
                    if (tc.function?.arguments) {
                      toolCallAccum[idx].args += tc.function.arguments;
                    }
                    streamLog.addToolCall(idx, toolCallAccum[idx].id, tc.function?.name || extractNameFromToolId(tc.id) || "", tc.function?.arguments || "");
                  }
                }
                if (d.choices?.[0]?.finish_reason) streamLog.setFinishReason(d.choices[0].finish_reason);
                if (d.usage) streamLog.setUsage(d.usage);
              } catch {}
            }
          }
        }

        // Final flush of greeting buffer: some upstreams (agnes, bitnet) emit
        // a short complete response in one chunk with finish_reason=null and
        // then close the stream. Without this, the content sits in gBuf and
        // never reaches the client.
        if (!gDone && gBuf.length > 0) {
          const s = stripCopilotGreeting(gBuf);
          if (s.length > 0) {
            fullContent += s;
            sock.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, delta: s })}\n\n`);
          }
          gDone = true;
        }

        const outputItems: any[] = [{ id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: fullContent }] }];
        sock.write(`event: response.output_text.done\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, text: fullContent })}\n\n`);
        sock.write(`event: response.content_part.done\ndata: ${JSON.stringify({ response_id: respId, item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: "text", text: fullContent } })}\n\n`);
        sock.write(`event: response.output_item.done\ndata: ${JSON.stringify({ response_id: respId, output_index: outputIndex, item: { id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: fullContent }], status: "completed" } })}\n\n`);

        // ── Tool salvager (responses streaming path) ──
        // Buffer was collected during stream; run salvager on accumulated tool calls.
        const accumulatedToolCalls = Object.keys(toolCallAccum).length
          ? Object.values(toolCallAccum).map(a => ({ id: a.id, type: "function", function: { name: a.name, arguments: a.args } }))
          : [];
        let useTaskComplete = false;
        if (accumulatedToolCalls.length) {
          const { repaired, dropped } = repairToolCalls(accumulatedToolCalls);
          const allDropped = accumulatedToolCalls.length > 0 && repaired.length === 0;
          const isApology = detectApologyText(fullContent);
          const isLoop = repaired.length
            ? detectToolLoop(messages, { name: repaired[0].function?.name || "", arguments: repaired[0].function?.arguments || "{}" })
            : { inLoop: false, count: 0, tool: "", args: "" };
          if ((isApology && allDropped) || isLoop.inLoop) {
            bumpSalvageStat(isLoop.inLoop ? "loopInjected" : "apologyInjected");
            console.log(`[TOOL SALVAGE] ${model}: ${isLoop.inLoop ? `loop(${isLoop.tool}×${isLoop.count})` : "apology"} → task_complete`);
            useTaskComplete = true;
          } else if (repaired.length !== accumulatedToolCalls.length || dropped.length) {
            console.log(`[TOOL SALVAGE] ${model}: ${repaired.length}/${accumulatedToolCalls.length} tool_calls repaired, ${dropped.length} dropped`);
          }
        } else if (detectApologyText(fullContent)) {
          bumpSalvageStat("apologyInjected");
          console.log(`[TOOL SALVAGE] ${model}: pure apology text → task_complete`);
          useTaskComplete = true;
        }

        if (useTaskComplete) {
          // Drop all original tool calls; emit a single task_complete
          const tcId = `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
          const tcOutIdx = nextToolOutputIdx++;
          outputItems.push({ id: tcId, type: "function_call", status: "completed", name: "task_complete", call_id: tcId, arguments: "{}" });
          sock.write(`event: response.output_item.added\ndata: ${JSON.stringify({ response_id: respId, output_index: tcOutIdx, item: { id: tcId, type: "function_call", status: "in_progress", name: "", arguments: "" } })}\n\n`);
          sock.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: tcId, output_index: tcOutIdx, delta: '{"name":"task_complete","arguments":"' })}\n\n`);
          sock.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: tcId, output_index: tcOutIdx, delta: '{}"}' })}\n\n`);
          sock.write(`event: response.output_item.done\ndata: ${JSON.stringify({ response_id: respId, output_index: tcOutIdx, item: { id: tcId, type: "function_call", status: "completed", name: "task_complete", call_id: tcId, arguments: "{}" } })}\n\n`);
        } else {
          // Emit buffered tool call events.
          // IMPORTANT: response.function_call_arguments.delta must contain the
          // RAW arguments string (e.g. `{}`), NOT a wrapped
          // `{"name":"...","arguments":"..."}` JSON object. The old code built
          // such a wrapper by string concatenation and never closed it,
          // producing malformed JSON that VS couldn't parse. The tool name
          // belongs in the output_item.added event, not in the args delta.
          for (const [idxStr, acc] of Object.entries(toolCallAccum)) {
            const idx = +idxStr;
            sock.write(`event: response.output_item.added\ndata: ${JSON.stringify({ response_id: respId, output_index: acc.ouputIndex, item: { id: acc.id, type: "function_call", status: "in_progress", name: acc.name, call_id: acc.id, arguments: "" } })}\n\n`);
            const args = acc.args || "{}";
            sock.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ response_id: respId, item_id: acc.id, output_index: acc.ouputIndex, call_id: acc.id, delta: args })}\n\n`);
            sock.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ response_id: respId, item_id: acc.id, output_index: acc.ouputIndex, call_id: acc.id, arguments: args })}\n\n`);
            outputItems.push({ id: acc.id, type: "function_call", status: "completed", name: acc.name, call_id: acc.id, arguments: args });
            sock.write(`event: response.output_item.done\ndata: ${JSON.stringify({ response_id: respId, output_index: acc.ouputIndex, item: { id: acc.id, type: "function_call", status: "completed", name: acc.name, call_id: acc.id, arguments: args } })}\n\n`);
          }
        }
        sock.write(`event: response.completed\ndata: ${JSON.stringify({ response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model, instructions, status: "completed", incomplete_details: null, output: outputItems, usage: { input_tokens: 0, output_tokens: fullContent.length, total_tokens: fullContent.length } } })}\n\n`);
        sock.end();
        const elapsed = Date.now() - startTime;
        if (completeLog) completeLog(elapsed);
        streamLog.flush();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      if (completeLog) completeLog(elapsed);
      const tcId = `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      return { handled: true, response: jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: `Mock response (upstream: ${e.message})`, tool_calls: [{ id: tcId, type: "function", function: { name: "task_complete", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      })};
    }
  }

  // POST /models/session - create model selection session
  if (method === "POST" && url === "/models/session") {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = `sess-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
    const tokenPayload = JSON.stringify({ sub: forge.util.bytesToHex(forge.random.getBytesSync(20)), iat: now, exp: now + 3600 });
    const sessionToken = `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(tokenPayload).toString("base64url")}.${forge.util.bytesToHex(forge.random.getBytesSync(32))}`;
    return { handled: true, response: jsonResponse({
      available_models: ["claude-haiku-4.5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
      selected_model: "claude-haiku-4.5",
      session_token: sessionToken,
      session_id: sessionId,
      id: sessionId,
      expires_at: now + 3600,
    }) };
  }

  // GET /users/:username/events - user activity events
  if (method === "GET" && url.match(/\/users\/[^/]+\/events/)) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /embeddings/models - embedding model list
  if (method === "GET" && url === "/embeddings/models") {
    return { handled: true, response: jsonResponse({ data: [] }) };
  }

  // GET /agents/swe/internal/memory/v0/user/enabled - SWE agent memory check
  if ((method === "GET" || method === "POST") && url.includes("/agents/swe/")) {
    return { handled: true, response: jsonResponse({ enabled: true, memory: {} }) };
  }

  // GET /mcp (or /mcp/readonly) - real API returns 405 Method Not Allowed
  if (method === "GET" && (url === "/mcp" || url.startsWith("/mcp?") || url.includes("/mcp/readonly"))) {
    return { handled: true, response: { statusCode: 405, headers: { "allow": "POST", "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Authorization, X-MCP-Readonly, X-MCP-Toolsets, X-MCP-Tools, X-MCP-Exclude-Tools, X-MCP-Features, X-MCP-Lockdown, X-MCP-Insiders", "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate", "access-control-max-age": "86400", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000" }, body: Buffer.from("Method Not Allowed\n") } };
  }

  // POST /mcp (or /mcp/readonly) - MCP protocol operations (SSE stream)
  if (method === "POST" && (url.includes("/mcp/readonly") || url === "/mcp" || url.startsWith("/mcp?"))) {
    let mcpBody: any = {};
    try { mcpBody = JSON.parse(body?.toString() || "{}"); } catch {}
    const mcpId = mcpBody.id ?? 1;

    if (mcpBody.method === "initialize") {
      const sessionId = `${forge.util.bytesToHex(forge.random.getBytesSync(4))}-${forge.util.bytesToHex(forge.random.getBytesSync(2))}-4${forge.util.bytesToHex(forge.random.getBytesSync(2))}-${["8","9","a","b"][Math.floor(Math.random()*4)]}${forge.util.bytesToHex(forge.random.getBytesSync(2))}-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      const response: any = {
        jsonrpc: "2.0", id: mcpId,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { completions: {}, prompts: {}, resources: {}, tools: {} },
          serverInfo: {
            name: "github-mcp-server",
            title: "GitHub MCP Server",
            version: "github-mcp-server/remote-607855159a6f284040de21449d3d8071e335733d",
            icons: [{ src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAWklEQVRIS2NkYGBg+M+AHzCCMQYwRjBGMMYIxgjGCMEYIYMRjIyMjP8ZGRn/M2IqZwRjYAMwRjDGCMYIxhrBGMAYuQAZwRjYAPwNGMEYIxhjBGMAAKKcChkUFuRaAAAAAElFTkSuQmCC", "media-type": "image/png" }]
          },
        },
      };
      const sseBody = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Authorization, X-MCP-Readonly, X-MCP-Toolsets, X-MCP-Tools, X-MCP-Exclude-Tools, X-MCP-Features, X-MCP-Lockdown, X-MCP-Insiders", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate", "access-control-max-age": "86400", "content-security-policy": "default-src 'none'; sandbox", "mcp-session-id": sessionId, "strict-transport-security": "max-age=31536000" }, body: Buffer.from(sseBody) } };
    }

    if (mcpBody.method === "notifications/initialized") {
      return { handled: true, response: { statusCode: 202, headers: { "content-length": "0", "access-control-allow-origin": "*", "content-security-policy": "default-src 'none'; sandbox", "strict-transport-security": "max-age=31536000" }, body: Buffer.alloc(0) } };
    }

    if (mcpBody.method === "tools/list") {
      const response = {
        jsonrpc: "2.0", id: mcpId,
        result: {
          tools: [
            {
              annotations: { readOnlyHint: true, title: "Get details of GitHub Actions resources (workflows, workflow runs, jobs, and artifacts)" },
              description: "Get details about specific GitHub Actions resources.\nUse this tool to get details about individual workflows, workflow runs, jobs, and artifacts by their unique IDs.\n",
              inputSchema: { type: "object", properties: { method: { type: "string", description: "The method to execute", enum: ["get_workflow", "get_workflow_run", "get_workflow_job", "download_workflow_run_artifact", "get_workflow_run_usage", "get_workflow_run_logs_url"] }, owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, resource_id: { type: "string", description: "The unique identifier of the resource" } }, required: ["method", "owner", "repo", "resource_id"] },
              name: "github-mcp-server-actions_get",
            },
            {
              annotations: { readOnlyHint: true, title: "List GitHub Actions resources" },
              description: "List GitHub Actions resources like workflows, workflow runs, and jobs.\nUse this tool to list available workflows, workflow runs, and jobs for a repository.\n",
              inputSchema: { type: "object", properties: { method: { type: "string", description: "The method to execute", enum: ["list_workflows", "list_workflow_runs", "list_jobs_for_workflow_run"] }, owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, page: { type: "number", description: "Page number for pagination" }, per_page: { type: "number", description: "Items per page" } }, required: ["method", "owner", "repo"] },
              name: "github-mcp-server-actions_list",
            },
            {
              annotations: { readOnlyHint: true, title: "Get file contents from a GitHub repository" },
              description: "Get the contents of a file or directory from a GitHub repository at a specific ref (branch, tag, or commit).\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, path: { type: "string", description: "Path to the file or directory" }, ref: { type: "string", description: "Git ref (branch, tag, or commit SHA)" } }, required: ["owner", "repo", "path"] },
              name: "github-mcp-server-get_file_contents",
            },
            {
              annotations: { readOnlyHint: true, title: "Search code in a GitHub repository" },
              description: "Search for code across GitHub repositories using the GitHub code search API.\n",
              inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, owner: { type: "string", description: "Repository owner to search within" }, repo: { type: "string", description: "Repository name to search within" } }, required: ["query"] },
              name: "github-mcp-server-search_code",
            },
            {
              annotations: { readOnlyHint: true, title: "List issues in a GitHub repository" },
              description: "List issues in a GitHub repository with optional filtering.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, state: { type: "string", description: "Issue state", enum: ["open", "closed", "all"] }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] },
              name: "github-mcp-server-list_issues",
            },
            {
              annotations: { readOnlyHint: true, title: "Read an issue" },
              description: "Get details of a specific issue including comments.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, issue_number: { type: "number", description: "Issue number" } }, required: ["owner", "repo", "issue_number"] },
              name: "github-mcp-server-issue_read",
            },
            {
              annotations: { readOnlyHint: true, title: "Search issues" },
              description: "Search for issues across GitHub using the search API.\n",
              inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, owner: { type: "string" }, repo: { type: "string" } }, required: ["query"] },
              name: "github-mcp-server-search_issues",
            },
            {
              annotations: { readOnlyHint: true, title: "List pull requests" },
              description: "List pull requests in a GitHub repository.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, state: { type: "string", enum: ["open", "closed", "all"] }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] },
              name: "github-mcp-server-list_pull_requests",
            },
            {
              annotations: { readOnlyHint: true, title: "Read a pull request" },
              description: "Get details of a specific pull request including its diff and review status.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, pull_number: { type: "number", description: "Pull request number" } }, required: ["owner", "repo", "pull_number"] },
              name: "github-mcp-server-pull_request_read",
            },
            {
              annotations: { readOnlyHint: true, title: "Search pull requests" },
              description: "Search for pull requests across GitHub.\n",
              inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, owner: { type: "string" }, repo: { type: "string" } }, required: ["query"] },
              name: "github-mcp-server-search_pull_requests",
            },
            {
              annotations: { readOnlyHint: true, title: "List branches in a repository" },
              description: "List branches in a GitHub repository.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] },
              name: "github-mcp-server-list_branches",
            },
            {
              annotations: { readOnlyHint: true, title: "List commits" },
              description: "List commits in a GitHub repository.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, sha: { type: "string", description: "Branch or commit SHA" }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] },
              name: "github-mcp-server-list_commits",
            },
            {
              annotations: { readOnlyHint: true, title: "Get a commit" },
              description: "Get details of a specific commit.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, ref: { type: "string", description: "Commit SHA or ref" } }, required: ["owner", "repo", "ref"] },
              name: "github-mcp-server-get_commit",
            },
            {
              annotations: { readOnlyHint: true, title: "Search repositories" },
              description: "Search for repositories on GitHub.\n",
              inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, sort: { type: "string", enum: ["stars", "forks", "updated"] }, order: { type: "string", enum: ["asc", "desc"] }, page: { type: "number" }, per_page: { type: "number" } }, required: ["query"] },
              name: "github-mcp-server-search_repositories",
            },
            {
              annotations: { readOnlyHint: true, title: "Search users" },
              description: "Search for users on GitHub.\n",
              inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
              name: "github-mcp-server-search_users",
            },
            {
              annotations: { readOnlyHint: true, title: "Get job logs" },
              description: "Get the logs for a specific GitHub Actions workflow run job.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, job_id: { type: "string", description: "Job ID" } }, required: ["owner", "repo", "job_id"] },
              name: "github-mcp-server-get_job_logs",
            },
            {
              annotations: { readOnlyHint: true, title: "List workflow runs" },
              description: "List workflow runs for a repository.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, workflow_id: { type: "string" }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] },
              name: "github-mcp-server-list_workflow_runs",
            },
            {
              annotations: { readOnlyHint: true, title: "Get workflow run" },
              description: "Get details of a specific workflow run.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, run_id: { type: "string", description: "Workflow run ID" } }, required: ["owner", "repo", "run_id"] },
              name: "github-mcp-server-get_workflow_run",
            },
            {
              annotations: { readOnlyHint: true, title: "Get workflow run logs URL" },
              description: "Get the logs download URL for a workflow run.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, run_id: { type: "string", description: "Workflow run ID" } }, required: ["owner", "repo", "run_id"] },
              name: "github-mcp-server-get_workflow_run_logs_url",
            },
            {
              annotations: { readOnlyHint: true, title: "Download workflow run artifact" },
              description: "Download an artifact from a workflow run.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, artifact_id: { type: "string", description: "Artifact ID" } }, required: ["owner", "repo", "artifact_id"] },
              name: "github-mcp-server-download_workflow_run_artifact",
            },
            {
              annotations: { readOnlyHint: true, title: "Get workflow run usage" },
              description: "Get billing/usage information for a workflow run.\n",
              inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, run_id: { type: "string", description: "Workflow run ID" } }, required: ["owner", "repo", "run_id"] },
              name: "github-mcp-server-get_workflow_run_usage",
            },
          ],
        },
      };
      const sseBody = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Authorization, X-MCP-Readonly, X-MCP-Toolsets, X-MCP-Tools, X-MCP-Exclude-Tools, X-MCP-Features, X-MCP-Lockdown, X-MCP-Insiders", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate", "access-control-max-age": "86400", "content-security-policy": "default-src 'none'; sandbox", "strict-transport-security": "max-age=31536000" }, body: Buffer.from(sseBody) } };
    }

    if (mcpBody.method === "resources/list") {
      return { handled: true, response: jsonResponse({ jsonrpc: "2.0", id: mcpId, result: { resources: [] } }) };
    }

    if (mcpBody.method === "resources/templates/list") {
      return { handled: true, response: jsonResponse({ jsonrpc: "2.0", id: mcpId, result: { resourceTemplates: [] } }) };
    }

    if (mcpBody.method === "prompts/list") {
      return {
        handled: true,
        response: jsonResponse({
          jsonrpc: "2.0", id: mcpId,
          result: {
            prompts: [
              { name: "explain_code", description: "Explain selected code", arguments: [{ name: "code", description: "Code to explain", required: true }] },
              { name: "review_code", description: "Review code for issues", arguments: [{ name: "code", description: "Code to review", required: true }] },
              { name: "generate_tests", description: "Generate tests for code", arguments: [{ name: "code", description: "Code to test", required: true }] },
            ],
          },
        }),
      };
    }

    if (mcpBody.method === "prompts/get") {
      const promptName = mcpBody.params?.name || "unknown";
      return { handled: true, response: jsonResponse({ jsonrpc: "2.0", id: mcpId, result: { description: `Prompt: ${promptName}`, messages: [{ role: "user", content: { type: "text", text: `Mock prompt execution for "${promptName}"` } }] } }) };
    }

    return { handled: true, response: jsonResponse({ jsonrpc: "2.0", id: mcpId, result: {} }) };
  }
  // POST /completions - code completions (inline suggestions)

  if (method === "POST" && url.includes("/completions") && !url.includes("/chat/completions")) { trackRequest("copilot");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}

    const prompt = parsed.prompt || parsed.suffix || "";
    const language = parsed.language || parsed.lang || "typescript";
    const model = parsed.model || "supermaven-free";
    const isStream = parsed.stream === true;
    const tag = agentTag(headers);

    const completionsComplete = reqLog({ tag, provider: "fim", model, preview: prompt.substring(0, 120) });
    const completionsStart = Date.now();

    // 1) Try Supermaven first
    let completion = "";
    const useSupermaven = isSupermavenEnabled() && isSupermavenReady();

    if (useSupermaven) {
      try {
        completion = await supermavenCodeComplete(prompt);
        if (completion) console.log(`[SUPERMAVEN] ${tag} result: "${completion.substring(0, 80)}"`);
      } catch (e: any) {
        console.log(`[SUPERMAVEN] ${tag} error: ${e.message}`);
      }
    }

    // 2) Try dashboard completions model (e.g. codestral) using legacy FIM
    const completionsModel = getCompletionsModel();
    if (!completion && completionsModel && completionsModel.startsWith("codestral")) {
      try {
        const suffix = parsed.suffix || "";
        const resp = await codestralFim(prompt, suffix, completionsModel, { max_tokens: parsed.max_tokens ?? 500, temperature: parsed.temperature ?? 0.2, top_p: parsed.top_p ?? 1, stream: false });
        if (resp.ok) {
          const data: any = await resp.json();
          completion = data.choices?.[0]?.text || data.choices?.[0]?.message?.content || "";
          if (completion) console.log(`[CODESTRAL FIM] ${tag} result: "${completion.substring(0, 80)}"`);
        }
      } catch (e: any) {
        console.log(`[CODESTRAL FIM] ${tag} error: ${e.message}`);
      }
    }

    // 3) Fallback: static mock
    if (!completion) {
      const completionMap: Record<string, string> = {
        "// ": "complete this line\nfunction processData(input: string): void {\n  // Implementation here\n}\n",
        "function ": "processData(input: string): void {\n  // TODO: implement\n}\n",
        "import ": "{ readFileSync, writeFileSync } from 'node:fs';\nimport { join, resolve } from 'node:path';\n",
        "const ": "result = await fetchData();\nif (!result.ok) throw new Error('Failed to fetch');\n",
      };
      completion = "// Mock completion\nfunction placeholder(): void {}\n";
      for (const [prefix, suffix] of Object.entries(completionMap)) {
        if (prompt.includes(prefix)) { completion = suffix; break; }
      }
    }

    if (completionsComplete) completionsComplete(Date.now() - completionsStart);

    return {
      handled: true,
      response: jsonResponse({
        id: `cmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          text: completion,
          index: 0,
          finish_reason: "stop",
          logprobs: null,
        }],
        usage: { prompt_tokens: prompt.length / 4, completion_tokens: completion.split(" ").length, total_tokens: 0 },
      }),
    };
  }
  // POST /v1/embeddings

  if (method === "POST" && url.includes("/embeddings")) { trackRequest("copilot");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}

    const input = parsed.input || "";
    const inputCount = Array.isArray(input) ? input.length : 1;
    const dims = 1536;
    const data = Array.from({ length: inputCount }, (_, i) => ({
      object: "embedding",
      index: i,
      embedding: Array.from({ length: dims }, () => (Math.random() * 2 - 1) * 0.01),
    }));
    return {
      handled: true,
      response: jsonResponse({
        object: "list",
        data,
        model: "text-embedding-3-small",
        usage: { prompt_tokens: inputCount * 2, total_tokens: inputCount * 2 },
      }),
    };
  }
  // POST /v1/tokenize

  if (method === "POST" && url.includes("/tokenize")) { trackRequest("copilot");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const text = parsed.text || parsed.input || "";
    return {
      handled: true,
      response: jsonResponse({
        tokens: text.split(/\s+/).map((w: string) => `<${w}>`),
        count: text.split(/\s+/).length,
      }),
    };
  }

  // GET /v1/health or /health (not bare /, which would block github.com in hybrid mode)
  if ((method === "GET" || method === "HEAD") && (url.includes("/health") && url !== "/")) {
    return { handled: true, response: jsonResponse({ status: "ok", service: "copilot-proxy" }) };
  }

  // GET /usage or /v1/usage - VS quota/usage endpoint
  if (method === "GET" && (url === "/usage" || url === "/v1/usage" || url.startsWith("/usage?") || url.startsWith("/v1/usage?"))) {
    return { handled: true, response: jsonResponse({
      quota: {
        chat: { limit: 500, used: 500, remaining: 0, reset: "2120-01-01T00:00:00Z" },
        completions: { limit: 4000, used: 68, remaining: 3932, reset: "2120-01-01T00:00:00Z" },
      },
      percentage: 1.7,
    })};
  }

  return { handled: false };
}
