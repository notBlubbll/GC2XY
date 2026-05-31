import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult, countConsecutiveNags, stripNagMessages, RECENTLY_COMPLETED, RECENT_BODIES } from "../../shared.ts";
import { chatCompletion as opencodeChat, initModels, detectSessionSignal, extractUserPrompt, getModelDisplayName } from "../opencode-client.ts";
import { handleVSModels } from "./models.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";
import { trackRequest } from "../../usage-tracker.ts";
import { anthropicToOpenAIRequest } from "../anthropic-bridge.ts";

const FAKE_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;

function _extractText(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((b: any) => {
    if (typeof b === "string") return b;
    if (b.text) return b.text;
    if (b.content) return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    return "";
  }).join(" ");
  if (raw && typeof raw === "object") {
    if (raw.text) return raw.text;
    if (raw.content) return typeof raw.content === "string" ? raw.content : _extractText(raw.content);
    if (raw.value) return raw.value;
    return JSON.stringify(raw);
  }
  return "";
}

function detectVendor(id: string): string {
  const l = id.toLowerCase();
  if (l.includes("deepseek") || l.includes("mimo")) return "OpenAI";
  if (l.includes("claude")) return "Anthropic";
  if (l.includes("gpt") || l.includes("codex") || l.includes("o1") || l.includes("o3")) return "OpenAI";
  if (l.includes("gemini")) return "Google";
  if (l.includes("minimax")) return "MiniMax";
  if (l.includes("kimi") || l.includes("k2p")) return "Moonshot AI";
  if (l.includes("qwen")) return "Alibaba Cloud";
  if (l.includes("glm")) return "Zhipu AI";
  if (l.includes("hy3")) return "H Company";
  if (l.includes("nemotron")) return "NVIDIA";
  if (l.includes("big-pickle")) return "Opencode";
  if (l.includes("ring")) return "Ring";
  return "Opencode";
}

function getThinkingModes(id: string): string[] {
  const l = id.toLowerCase();
  if (l.includes("deepseek-v4")) return ["LOW", "MEDIUM", "HIGH", "MAXIMUM"];
  if (l.includes("mimo")) return ["LOW", "MEDIUM", "HIGH"];
  return [];
}

const THINKING_TAG_PARAMS: Record<string, Record<string, string>> = {
  LOW: { reasoningEffort: "low" },
  MEDIUM: { reasoningEffort: "medium" },
  HIGH: { reasoningEffort: "high" },
  MAXIMUM: { reasoningEffort: "max" },
  MED: { reasoningEffort: "medium" },
  MAX: { reasoningEffort: "max" },
};

const SHORT_TAG: Record<string, string> = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX" };

function modelSupports(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const base: any = { parallel_tool_calls: true, streaming: true, tool_calls: true };
  if (isChat) base.structured_outputs = true;
  if (isChat) base.vision = true;
  const supportsDeepThink = l.includes("deepseek") || l.includes("claude") || l.includes("mimo") ||
    l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini")) || l.includes("big-pickle");
  if (supportsDeepThink) {
    base.adaptive_thinking = true;
    base.min_thinking_budget = 1024;
    base.max_thinking_budget = l.includes("big-pickle") ? 64000 : 32000;
  }
  if (l.includes("deepseek-v4")) {
    base.reasoning_effort = ["low", "medium", "high", "xhigh"];
  }
  if (l.includes("mimo") && !supportsDeepThink) {
    base.reasoning_effort = ["low", "medium", "high"];
  }
  return base;
}

function modelLimits(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const limits: any = {};
  if (l.includes("big-pickle")) {
    limits.max_context_window_tokens = 1000000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 900000; limits.max_non_streaming_output_tokens = 64000;
  } else if (l.includes("deepseek") || l.includes("claude")) {
    limits.max_context_window_tokens = 200000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 200000; limits.max_non_streaming_output_tokens = 16000;
  } else if (l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini"))) {
    limits.max_context_window_tokens = 400000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 272000; limits.max_non_streaming_output_tokens = 32000;
  } else if (l.includes("gpt-5-mini") || l.includes("gpt-5.4-mini") || l.includes("gpt-5.4-nano") || l.includes("gpt-5-nano")) {
    limits.max_context_window_tokens = 264000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 128000; limits.max_non_streaming_output_tokens = 16000;
  } else {
    limits.max_context_window_tokens = 128000; limits.max_output_tokens = 16384; limits.max_prompt_tokens = 64000; limits.max_non_streaming_output_tokens = 4096;
  }
  if (isChat) {
    limits.vision = { max_prompt_image_size: 3145728, max_prompt_images: 5, supported_media_types: ["image/jpeg", "image/png", "image/webp", "image/gif"] };
  }
  return limits;
}

async function ensureModels() {
  if (_rebuilding) return;
  const models = await initModels();

  const changed = models.length !== _lastModelIds.length ||
    models.some((id, i) => id !== _lastModelIds[i]);
  if (!changed && FAKE_MODELS.length > 0) return;
  _lastModelIds = [...models];

  _rebuilding = true;
  FAKE_MODELS.length = 0;
  const seen = new Set<string>();

  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const name = getModelDisplayName(id);
    const baseModel = {
      id, object: "model",
      name, vendor: detectVendor(id), version: id, preview: false,
      model_picker_category: id.includes("mini") || id.includes("nano") || (id.includes("flash") && !id.includes("deepseek")) || id.includes("haiku") || id.includes("free") ? "lightweight" : id.includes("pro") || id.includes("opus") || id.includes("codex") || id.includes("omni") || (id.includes("flash") && id.includes("deepseek")) ? "powerful" : "versatile",
      model_picker_enabled: true,
      is_chat_default: true,
      is_chat_fallback: true,
      billing: { is_premium: true, multiplier: 1, restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"] },

      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: id, object: "model_capabilities", type: "chat", tokenizer: "o200k_base",
        limits: modelLimits(id),
        supports: modelSupports(id),
      },
    };
    FAKE_MODELS.push(baseModel);

    const modes = getThinkingModes(id);
    for (const mode of modes) {
      const tag = SHORT_TAG[mode] || mode;
      const taggedId = `${id} [${tag}]`;
      if (seen.has(taggedId)) continue;
      seen.add(taggedId);
      let taggedName = `${name} [${tag}]`;
      let displayBaseName = name;
      if (taggedName.length > 24) {
        displayBaseName = displayBaseName.replace(/\s/g, "");
        taggedName = `${displayBaseName} [${tag}]`;
      }
      let cap = JSON.parse(JSON.stringify(baseModel.capabilities));
      cap.supports = { ...cap.supports, reasoning_effort: [mode.toLowerCase()] };
      FAKE_MODELS.push({
        ...baseModel,
        id: taggedId,
        name: taggedName,
        model_picker_enabled: true,
        is_chat_default: false,
        is_chat_fallback: false,
        capabilities: cap,
      });
    }
  };

  for (const id of models) addModel(id);
  console.log(`[MODEL CACHE] vs-handler rebuilt ${FAKE_MODELS.length} models`);
  _rebuilding = false;
}

function parseThinkingMode(modelName: string): { model: string; thinking: string | null } {
  const clean = (modelName || "").trim();
  if (!clean) return { model: modelName, thinking: null };
  const m = clean.match(/^(.+?)\s+\[(LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX|LO|MD|HI|MX)\]\s*$/i);
  if (m) {
    const SHORT_MAP: Record<string, string> = { LO: "LOW", MD: "MEDIUM", HI: "HIGH", MX: "MAXIMUM", MED: "MEDIUM", MAX: "MAXIMUM" };
    const raw = m[2].toUpperCase();
    const tag = SHORT_MAP[raw] || raw;
    return { model: m[1].trim(), thinking: tag };
  }
  return { model: modelName, thinking: null };
}

export async function handleVisualStudio(req: HandlerInput): Promise<HandlerResult> {
  const vsReqStart = Date.now();
  const { method, url, body, headers } = req;

  const editorVersion = headers["editor-version"] || "";
  const isVisualStudio = editorVersion.startsWith("VS/VisualStudio");

  if (!isVisualStudio) return { handled: false };

  console.log(`[VISUAL STUDIO] ${method} ${url} (editor: ${editorVersion})`);

  // POST /v1/messages - Visual Studio Copilot chat endpoint (Anthropic Messages API)
  if (method === "POST" && url === "/v1/messages") { trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const _v1NagModel = parsed.model || "";
    const _v1NagMessages = parsed.messages || [];

    // ── Nag: drain → auto-resolve → forward + append ──
    // Body dedup: skip identical bodies within 20s
    const _bodyStr = body?.toString() || "";
    const _vssId = headers["x-vss-session-id"] || headers["X-VSS-Session-Id"] || "";
    const _dedupKey = _vssId ? `${_vssId}:${_bodyStr.length}:${_bodyStr.slice(-50)}` : `${_bodyStr.length}:${_bodyStr.slice(-50)}`;
    if ((RECENT_BODIES.get(_dedupKey) ?? 0) && Date.now() - (RECENT_BODIES.get(_dedupKey) ?? 0) < 20000) {
      RECENT_BODIES.set(_dedupKey, Date.now());
      const _toolId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const _nagId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const msgStart = JSON.stringify({ type: "message_start", message: { id: _nagId, type: "message", role: "assistant", content: [], model: _v1NagModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      const blockStart = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: _toolId, name: "task_complete", input: {} } });
      const blockStop = JSON.stringify({ type: "content_block_stop", index: 0 });
      const msgDelta = JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } });
      const msgStop = JSON.stringify({ type: "message_stop" });
      const sse = `event: message_start\ndata: ${msgStart}\n\nevent: content_block_start\ndata: ${blockStart}\n\nevent: content_block_stop\ndata: ${blockStop}\n\nevent: message_delta\ndata: ${msgDelta}\n\nevent: message_stop\ndata: ${msgStop}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }
    RECENT_BODIES.set(_dedupKey, Date.now());

    // ── Nag: drain → empty stop, nag → task_complete ──
    const _nagCount = countConsecutiveNags(_v1NagMessages);
    if (RECENTLY_COMPLETED.get(_v1NagModel) && Date.now() - RECENTLY_COMPLETED.get(_v1NagModel) < 20000) {
      RECENTLY_COMPLETED.delete(_v1NagModel);
      const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const msgStart = JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: _v1NagModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      const msgDelta = JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
      const msgStop = JSON.stringify({ type: "message_stop" });
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(`event: message_start\ndata: ${msgStart}\n\nevent: message_delta\ndata: ${msgDelta}\n\nevent: message_stop\ndata: ${msgStop}\n\n`) } };
    }
    if (_nagCount > 0) {
      RECENTLY_COMPLETED.set(_v1NagModel, Date.now());
      stripNagMessages(_v1NagMessages);
      const nagId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const toolId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const msgStart = JSON.stringify({ type: "message_start", message: { id: nagId, type: "message", role: "assistant", content: [], model: _v1NagModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      const blockStart = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: "task_complete", input: {} } });
      const blockStop = JSON.stringify({ type: "content_block_stop", index: 0 });
      const msgDelta = JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } });
      const msgStop = JSON.stringify({ type: "message_stop" });
      const sse = `event: message_start\ndata: ${msgStart}\n\nevent: content_block_start\ndata: ${blockStart}\n\nevent: content_block_stop\ndata: ${blockStop}\n\nevent: message_delta\ndata: ${msgDelta}\n\nevent: message_stop\ndata: ${msgStop}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }

    let model = _v1NagModel;
    const messages = _v1NagMessages;
    const isStream = parsed.stream === true;
    const tools = parsed.tools || [];
    const maxTokens = parsed.max_tokens || 4096;

    await ensureModels();
    const parsedTag = parseThinkingMode(model);
    model = parsedTag.model;
    if (parsedTag.thinking) {
      const params = THINKING_TAG_PARAMS[parsedTag.thinking];
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (parsed[k] === undefined) parsed[k] = v;
        }
      }
    }
    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
    };
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || model;
      console.log(`[MODEL VS/MESSAGES] Aliased → ${model}`);
    }
    if (!FAKE_MODELS.find((m: any) => m.id === model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/MESSAGES] ${model} not found, picked ${model}`);
    }

    try {
      const bridge = anthropicToOpenAIRequest(parsed);

      const vsSession = detectSessionSignal(bridge.messages);
      if (vsSession) {
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[VS SESSION] ${ts} [Session#${vsSession.sessNum}>${vsSession.keyLabel}] ${model} "${extractUserPrompt(bridge.messages).substring(0, 120)}"`);
      }

      const lastUserMsg = [...bridge.messages].reverse().find((m: any) => m.role === "user");
      const vsTag = agentTag(headers);
      const vsProvider = model.startsWith("pol/") ? "poll" : "go";
      const vsPreview = lastUserMsg ? (
        typeof lastUserMsg.content === "string" ? lastUserMsg.content :
        Array.isArray(lastUserMsg.content) ? lastUserMsg.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join(" ") : ""
      ) : "";
      const messagesComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: vsPreview, body: parsed });
      const startTime = Date.now();

      const resp = await opencodeChat(bridge.model, bridge.messages, bridge.tools, bridge.stream, {
        max_tokens: bridge.max_tokens,
        ...parsed,
      }, vsSession?.keyIdx);

      if (!isStream) {
        const openaiData: any = await resp.json();
        const elapsed = Date.now() - startTime;
        if (messagesComplete) messagesComplete(elapsed);
        const choice = openaiData.choices?.[0]?.message;
        const content = choice?.content || "";
        const toolCalls = choice?.tool_calls;

        const contentBlocks: any[] = [{ type: "text", text: content }];
        let stopReason = "end_turn";
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            const fn = tc.function || tc;
            let args: any = {};
            try { args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}"); } catch {}
            contentBlocks.push({ type: "tool_use", id: tc.id, name: fn.name || "unknown", input: args });
          }
          stopReason = "tool_use";
        }
        if (_nagAppend) {
          contentBlocks.push({ type: "tool_use", id: `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, name: "task_complete", input: {} });
          stopReason = "tool_use";
          RECENTLY_COMPLETED.set(model, Date.now());
        }

        const responseBody = {
          id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          model: model,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: openaiData.usage || { input_tokens: 0, output_tokens: 0 },
        };
        return { handled: true, response: jsonResponse(responseBody) };
      }

      const sock = req.clientSocket;
      if (sock) {
        const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
        sock.write(respHead);

        const sseEvent = (s: any, evt: string, data: any) => {
          if (s.destroyed || s.closed) return;
          s.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let nextContentIdx = 0;
        const toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};

        sseEvent(sock, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        sseEvent(sock, "content_block_start", { type: "content_block_start", index: nextContentIdx, content_block: { type: "text", text: "" } });

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
                  fullContent += delta.content;
                  sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: delta.content } });
                }
                if (delta?.reasoning_content) {
                  sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "reasoning_delta", reasoning: delta.reasoning_content } });
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccum[idx]) {
                      toolCallAccum[idx] = { id: tc.id || "", name: "", args: "" };
                      if (tc.id) {
                        nextContentIdx++;
                        sseEvent(sock, "content_block_start", { type: "content_block_start", index: nextContentIdx, content_block: { type: "tool_use", id: tc.id, name: "", input: {} } });
                      }
                    }
                    if (tc.id) toolCallAccum[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
                    if (tc.function?.arguments) {
                      toolCallAccum[idx].args += tc.function.arguments;
                      sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
                    }
                  }
                }
              } catch {}
            }
          }
        }

        sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: 0 });
        const toolBlockStartIdx = 1;
        const tcKeys = Object.keys(toolCallAccum);
        for (let i = 0; i < tcKeys.length; i++) {
          sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: toolBlockStartIdx + i });
        }
        if (_nagAppend) {
          const toolIdx = toolBlockStartIdx + tcKeys.length;
          const tcId = `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          sseEvent(sock, "content_block_start", { type: "content_block_start", index: toolIdx, content_block: { type: "tool_use", id: tcId, name: "task_complete", input: {} } });
          sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: toolIdx });
          RECENTLY_COMPLETED.set(model, Date.now());
        }

        const hasToolCalls = Object.keys(toolCallAccum).length > 0 || !!_nagAppend;
        sseEvent(sock, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: fullContent.length } });
        sseEvent(sock, "message_stop", { type: "message_stop" });
        sock.end();
        const elapsed = Date.now() - startTime;
        if (messagesComplete) messagesComplete(elapsed);

        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      const elapsed = Date.now() - startTime;
      if (messagesComplete) messagesComplete(elapsed);
      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      return { handled: true, response: jsonResponse({
        id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
        type: "message", role: "assistant",
        content: [{ type: "text", text: `Mock response (upstream: ${e.message})` }],
        model, stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      })};
    }
  }

  // POST /responses - Visual Studio Copilot responses endpoint (OpenAI Responses API)
  if (method === "POST" && (url === "/responses" || url.startsWith("/responses?"))) { trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const input = parsed.input || "";
    const instructions = parsed.instructions || "";
    const tools = parsed.tools || [];
    const isStream = parsed.stream === true;

    const userContent = typeof input === "string" ? input :
      Array.isArray(input) ? input.map((m: any) => m.content || "").join("\n") : "Hello";

    await ensureModels();
    const parsedTag = parseThinkingMode(model);
    model = parsedTag.model;
    if (parsedTag.thinking) {
      const params = THINKING_TAG_PARAMS[parsedTag.thinking];
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (parsed[k] === undefined) parsed[k] = v;
        }
      }
    }
    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
    };
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || model;
      console.log(`[MODEL VS/RESPONSES] Aliased → ${model}`);
    }
    if (!FAKE_MODELS.find((m: any) => m.id === model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/RESPONSES] ${model} not found, picked ${model}`);
    }

    try {
      const messages = [
        ...(instructions ? [{ role: "system", content: instructions }] : []),
        { role: "user", content: userContent },
      ];

      const vsSession = detectSessionSignal(messages);
      if (vsSession) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[VS SESSION] ${ts2} [Session#${vsSession.sessNum}>${vsSession.keyLabel}] ${model} "${extractUserPrompt(messages).substring(0, 120)}"`);
      }

      const vsTag = agentTag(headers);
      const vsProvider = model.startsWith("pol/") ? "poll" : "go";
      const responsesComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: userContent, body: parsed });
      const startTime = Date.now();

      const resp = await opencodeChat(model, messages, tools, isStream, { ...parsed }, vsSession?.keyIdx);
      if (!isStream) {
        const openaiData: any = await resp.json();
        const elapsed = Date.now() - startTime;
        if (responsesComplete) responsesComplete(elapsed);
        return { handled: true, response: jsonResponse(openaiData) };
      }

      const sock = req.clientSocket;
      if (sock) {
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
        sock.write(respHead);
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sock.write(decoder.decode(value, { stream: true }));
        }
        sock.end();
        const elapsed = Date.now() - startTime;
        if (responsesComplete) responsesComplete(elapsed);
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      const elapsed = Date.now() - startTime;
      if (responsesComplete) responsesComplete(elapsed);
      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      return { handled: true, response: jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: `Mock response (upstream: ${e.message})` }, finish_reason: "stop" }] })};
    }
  }

  // POST /chat/completions - VS sends OpenAI chat format too
  if (method === "POST" && url.includes("/chat/completions")) { trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const messages = parsed.messages || [];
    const isStream = parsed.stream === true;
    const tools = parsed.tools || [];
    const maxTokens = parsed.max_tokens || 4096;

    await ensureModels();
    const parsedTag = parseThinkingMode(model);
    model = parsedTag.model;
    if (parsedTag.thinking) {
      const params = THINKING_TAG_PARAMS[parsedTag.thinking];
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (parsed[k] === undefined) parsed[k] = v;
        }
      }
    }
    const modelOverrides: Record<string, string> = {
      "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
    };
    if (modelOverrides[model] !== undefined) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || model;
      console.log(`[MODEL VS/CHAT] Aliased → ${model}`);
    }
    if (!FAKE_MODELS.find((m: any) => m.id === model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/CHAT] ${model} not found, picked ${model}`);
    }

    // Sanitize tools: remove entries with empty function names
    const cleanTools = (tools || []).filter((t: any) => {
      const fn = t.function || t;
      return fn.name && fn.name.length > 0;
    });

    if (!messages.length) {
      messages.push({ role: "user", content: "Hello" });
    }

    // Session tracking (from ZEN-PROXY pattern)
    const session = detectSessionSignal(messages);
    let sessionLabel = "";
    if (session) {
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      sessionLabel = `[Session#${session.sessNum}>${session.keyLabel}]`;
      console.log(`[VS SESSION] ${ts} ${sessionLabel} ${model} "${extractUserPrompt(messages).substring(0, 120)}"`);
    }

    // Nag detection for /chat/completions
    const _chatLastUser = [...messages].reverse().find((m: any) => m.role === "user") || messages[messages.length - 1];
    const _chatContent = _extractText(_chatLastUser?.content);
    if (_chatContent && /not yet marked/i.test(_chatContent)) {
      console.log(`[VS NAG] Auto task_complete via /chat/completions`);
      return { handled: true, response: jsonResponse({
        id: `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
        object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model, choices: [{
          index: 0, message: {
            role: "assistant", content: "",
            tool_calls: [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }],
          }, finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })};
    }

    let vsChatComplete: any;
    try {
      const vsTag = agentTag(headers);
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const vsProvider = model.startsWith("pol/") ? "poll" : "go";
      const vsPreview = lastUserMsg ? (
        typeof lastUserMsg.content === "string" ? lastUserMsg.content :
        Array.isArray(lastUserMsg.content) ? lastUserMsg.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join(" ") : ""
      ) : "";
      vsChatComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: vsPreview, body: parsed });

      const resp = await opencodeChat(model, messages, cleanTools, isStream, { max_tokens: maxTokens, ...parsed }, session?.keyIdx);
      if (!isStream) {
        const data: any = await resp.json();
        recordTps(data.usage?.completion_tokens || (data.choices?.[0]?.message?.content || "").length, Date.now() - vsReqStart);
        if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
        return { handled: true, response: jsonResponse(data) };
      }

      const sock = req.clientSocket;
      if (sock) {
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n`;
        sock.write(respHead);
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let sseLen = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          sock.write(chunk);
          sseLen += chunk.length;
        }
        sock.end();
        recordTps(sseLen, Date.now() - vsReqStart);
        if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      const fallbackReader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let sse = "";
      while (true) {
        const { done, value } = await fallbackReader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
      }
      recordTps(sse.length, Date.now() - vsReqStart);
      if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(sse) } };
    } catch (e: any) {
      if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
      console.log(`[VS CHAT FALLBACK] ${e.message} — using local mock`);
      const mockContent = "I'm ready to help with your coding task. What would you like me to work on?";
      if (isStream) {
        const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        const created = Math.floor(Date.now() / 1000);
        let sse = `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`;
        sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"content":"${mockContent}"},"finish_reason":null}]}\n\n`;
        sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
        sse += "data: [DONE]\n\n";
        const sock = req.clientSocket;
        if (sock) {
          const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`;
          sock.write(respHead);
          sock.write(sse);
          sock.end();
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(sse) } };
      }
      return { handled: true, response: jsonResponse({
        id: `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
        object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model, choices: [{ index: 0, message: { role: "assistant", content: mockContent }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })};
    }
  }

  // POST /models - VS model list
  const vsModelsResult = await handleVSModels(req);
  if (vsModelsResult.handled) return vsModelsResult;

  // Catch-all for any other VS endpoint — return mock rather than falling through to upstream
  if (isVisualStudio) {
    return { handled: true, response: jsonResponse({ ok: true, message: "VS mock response" }) };
  }

  return { handled: false };
}

