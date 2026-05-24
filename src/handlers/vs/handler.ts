import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult } from "../../shared.ts";
import { chatCompletion as opencodeChat, initModels } from "../opencode-client.ts";
import { handleVSModels } from "./models.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";
import { anthropicToOpenAIRequest } from "../anthropic-bridge.ts";

let _lastNagTime = 0;
let _lastUserContent = "";

const FAKE_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;

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
    const name = id.split("-").map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ").replace(/(\d)\.(\d)/g, "$1.$2");
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
  if (method === "POST" && url === "/v1/messages") {
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
      console.log(`[MODEL VS/MESSAGES] Aliased → ${model}`);
    }
    if (!FAKE_MODELS.find((m: any) => m.id === model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/MESSAGES] ${model} not found, picked ${model}`);
    }

    // VS nag detection: auto task_complete for VS "not yet complete" messages
    const _lm = [...messages].reverse().find((m: any) => m.role === "user") || messages[messages.length - 1];
    const _lc = typeof _lm?.content === "string" ? _lm.content :
      Array.isArray(_lm?.content) ? _lm.content.map((c: any) => c.text || c.content || "").join(" ") : "";
    if (_lc && /not yet marked/i.test(_lc)) {
      console.log(`[VS NAG] Auto task_complete via /v1/messages`);
      return { handled: true, response: jsonResponse({
        id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
        type: "message", role: "assistant",
        content: [{ type: "tool_use", id: `toolu_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, name: "task_complete", input: {} }],
        model: model, stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        })};
    }

    try {
      const bridge = anthropicToOpenAIRequest(parsed);

      const resp = await opencodeChat(bridge.model, bridge.messages, bridge.tools, bridge.stream, {
        max_tokens: bridge.max_tokens,
        ...parsed,
      });

      if (!isStream) {
        const openaiData: any = await resp.json();
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

        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let nextContentIdx = 0;
        const toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};

        // Send message_start
        sock.write(`data: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        // Send content_block_start for text
        sock.write(`data: ${JSON.stringify({ type: "content_block_start", index: nextContentIdx, content_block: { type: "text", text: "" } })}\n\n`);

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
                  sock.write(`data: ${JSON.stringify({ type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: delta.content } })}\n\n`);
                }
                if (delta?.reasoning_content) {
                  sock.write(`data: ${JSON.stringify({ type: "content_block_delta", index: nextContentIdx, delta: { type: "reasoning_delta", reasoning: delta.reasoning_content } })}\n\n`);
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccum[idx]) {
                      toolCallAccum[idx] = { id: tc.id || "", name: "", args: "" };
                      // Emit content_block_start for tool_use when first seen
                      if (tc.id) {
                        nextContentIdx++;
                        sock.write(`data: ${JSON.stringify({ type: "content_block_start", index: nextContentIdx, content_block: { type: "tool_use", id: tc.id, name: "", input: {} } })}\n\n`);
                      }
                    }
                    if (tc.id) toolCallAccum[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
                    if (tc.function?.arguments) {
                      toolCallAccum[idx].args += tc.function.arguments;
                      sock.write(`data: ${JSON.stringify({ type: "content_block_delta", index: nextContentIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } })}\n\n`);
                    }
                  }
                }
              } catch {}
            }
          }
        }

        // Close text block
        sock.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        // Close tool_use blocks
        const toolBlockStartIdx = 1;
        for (let i = 0; i < Object.keys(toolCallAccum).length; i++) {
          sock.write(`data: ${JSON.stringify({ type: "content_block_stop", index: toolBlockStartIdx + i })}\n\n`);
        }

        const hasToolCalls = Object.keys(toolCallAccum).length > 0;
        const stopReason = hasToolCalls ? "tool_use" : "end_turn";
        sock.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: fullContent.length } })}\n\n`);
        sock.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        sock.end();

        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

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
  if (method === "POST" && (url === "/responses" || url.startsWith("/responses?"))) {
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

      const resp = await opencodeChat(model, messages, tools, isStream, { ...parsed });
      if (!isStream) {
        const openaiData: any = await resp.json();
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
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      return { handled: true, response: jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: `Mock response (upstream: ${e.message})` }, finish_reason: "stop" }] })};
    }
  }

  // POST /chat/completions - VS sends OpenAI chat format too
  if (method === "POST" && url.includes("/chat/completions")) {
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

    // VS nag detection: auto task_complete for VS "not yet complete" messages
    const _lastMsg = [...messages].reverse().find((m: any) => m.role === "user") || messages[messages.length - 1];
    const _lastContent = typeof _lastMsg?.content === "string" ? _lastMsg.content :
      Array.isArray(_lastMsg?.content) ? _lastMsg.content.map((c: any) => c.text || c.content || "").join(" ") :
      typeof _lastMsg?.content === "object" ? JSON.stringify(_lastMsg.content) : "";
    const _nagRe = /not yet marked/i;
    if (_lastContent && _nagRe.test(_lastContent)) {
      // Cooldown: prevent loop — drain silently if we just returned task_complete
      if (_lastNagTime && Date.now() - _lastNagTime < 30000) {
        console.log(`[VS NAG DRAIN] cooldown — draining`);
        const _dId = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        const _dCreated = Math.floor(Date.now() / 1000);
        if (isStream) { const _sock = req.clientSocket; if (_sock) {
          _sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
          _sock.write(`data: {"id":"${_dId}","object":"chat.completion.chunk","created":${_dCreated},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`);
          _sock.write(`data: {"id":"${_dId}","object":"chat.completion.chunk","created":${_dCreated},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
          _sock.write("data: [DONE]\n\n"); _sock.end(); return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }}
        return { handled: true, response: jsonResponse({ id: _dId, object: "chat.completion", created: _dCreated, model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })};
      }
      console.log(`[VS NAG] Auto task_complete via /chat/completions`);
      _lastNagTime = Date.now();
        const _n = new Date();
        const _ts = `[${String(_n.getHours()).padStart(2,"0")}:${String(_n.getMinutes()).padStart(2,"0")}:${String(_n.getSeconds()).padStart(2,"0")}]`;
        const _id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        const _created = Math.floor(Date.now() / 1000);
        const _callId = `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        const _fakeText = `Sent at ${_ts}`;
        if (isStream) {
          const _sock = req.clientSocket;
          if (_sock) {
            _sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
            _sock.write(`data: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"${_fakeText}"},"finish_reason":null}]}\n\n`);
            _sock.write(`data: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"${_callId}","type":"function","function":{"name":"task_complete","arguments":"{}"}}]},"finish_reason":null}]}\n\n`);
            _sock.write(`data: {"id":"${_id}","object":"chat.completion.chunk","created":${_created},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`);
            _sock.write("data: [DONE]\n\n");
            _sock.end();
            return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
          }
        }
        return { handled: true, response: jsonResponse({
          id: _id, object: "chat.completion", created: _created,
          model, choices: [{ index: 0, message: { role: "assistant", content: _fakeText, tool_calls: [{ id: _callId, type: "function", function: { name: "task_complete", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })};
    }

    const _initiator = headers["x-initiator"] || "";
    _lastUserContent = _initiator !== "agent" ? _lastContent : _lastUserContent;
    // Real user message — reset nag cooldown
    if (_initiator !== "agent") _lastNagTime = 0;

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

      const resp = await opencodeChat(model, messages, cleanTools, isStream, { max_tokens: maxTokens, ...parsed });
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

