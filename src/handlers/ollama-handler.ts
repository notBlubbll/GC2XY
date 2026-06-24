import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult } from "../shared.ts";
import { chatCompletion as opencodeChat, initModels, getModelCtx, modelHasVision, storeReasoning } from "./opencode-client.ts";
import { reqLog, agentTag, isDebug } from "../split-console.ts";

const OLLAMA_VERSION = "0.6.5";

const THINKING_TAG_PARAMS: Record<string, string> = {
  LOW: "low", MEDIUM: "medium", HIGH: "high", MAXIMUM: "max",
  LO: "low", MD: "medium", HI: "high", MX: "max", MED: "medium", MAX: "max",
};

function parseThinkingTag(raw: string): { model: string; tag: string | null } {
  const clean = raw.replace(/:latest$/, "").replace(/:cloud$/, "").trim();
  const m = clean.match(/^(.+?)\s+\[(LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX|LO|MD|HI|MX)\]\s*$/i);
  if (m) return { model: m[1].trim(), tag: m[2].toUpperCase() };
  for (const [tag] of Object.entries(THINKING_TAG_PARAMS)) {
    if (clean.endsWith(":" + tag.toLowerCase()) || clean.endsWith(":" + tag)) {
      return { model: clean.slice(0, -(tag.length + 1)).replace(/:cloud$/, ""), tag };
    }
  }
  const slashM = clean.match(/^(.+?)\/\d+_\(?(low|medium|high|maximum|xhigh)\)?$/i);
  if (slashM) return { model: slashM[1].trim(), tag: slashM[2].toUpperCase() };
  return { model: clean, tag: null };
}

function normalizeToOpenCodeModel(raw: string): string {
  const { model } = parseThinkingTag(raw);
  const l = model.toLowerCase();
  const aliases: Record<string, string> = {
    "gpt-4o": "umans-deepseek-v4-pro", "gpt-4": "umans-deepseek-v4-flash", "gpt-3.5-turbo": "umans-qwen3.5-plus",
    "gpt-4-turbo": "umans-deepseek-v4-pro", "claude-haiku-4.5": "umans-qwen3.5-plus",
    "gpt-5-mini": "umans-minimax-m2.5", "gpt-4.1": "umans-deepseek-v4-flash",
  };
  return aliases[l] || model;
}

function formatContext(n: number): string {
  if (n >= 1000000) return `${Math.floor(n / 1000000)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return `${n}`;
}

const FAMILY_MAP: Record<string, string> = {
  "deepseek-v4-pro": "deepseek4", "deepseek-v4-flash": "deepseek4", "deepseek-v4": "deepseek4",
  "glm-5.1": "glm", "glm-5": "glm",
  "kimi-k2.6": "kimi-k2", "kimi-k2.5": "kimi-k2",
  "minimax-m2.7": "minimax-m2", "minimax-m2.5": "minimax-m2",
  "mimo-v2.5-pro": "mimo", "mimo-v2.5": "mimo", "mimo-v2-pro": "mimo", "mimo-v2-omni": "mimo", "mimo": "mimo",
  "qwen3.6-plus": "qwen3", "qwen3.5-plus": "qwen3",
  "hy3-preview": "hy3",
  "big-pickle": "big-pickle", "nemotron-3-super-free": "nemotron", "ring-2.6-1t-free": "ring",
};

const CAPABILITIES: Record<string, string[]> = {
  "deepseek-v4-pro": ["completion", "tools", "thinking"], "deepseek-v4-flash": ["completion", "tools", "thinking"],
  "deepseek-v4": ["completion", "tools", "thinking"],
  "glm-5.1": ["thinking", "completion", "tools"], "glm-5": ["thinking", "completion", "tools"],
  "kimi-k2.6": ["vision", "thinking", "completion", "tools"], "kimi-k2.5": ["thinking", "completion", "tools"],
  "minimax-m2.7": ["completion", "tools", "thinking"], "minimax-m2.5": ["completion", "tools", "thinking"],
  "mimo-v2.5-pro": ["completion", "tools", "thinking"], "mimo-v2.5": ["completion", "tools", "thinking"],
  "mimo-v2-pro": ["completion", "tools"], "mimo-v2-omni": ["completion", "tools"], "mimo": ["completion", "tools", "thinking"],
  "qwen3.6-plus": ["completion", "tools", "thinking"], "qwen3.5-plus": ["completion", "tools", "thinking"],
  "hy3-preview": ["completion", "tools"],
  "big-pickle": ["completion", "tools", "thinking"], "nemotron-3-super-free": ["completion", "tools"],
  "ring-2.6-1t-free": ["completion", "tools"],
};

function supportsThinkingVariants(id: string): boolean {
  const l = id.toLowerCase();
  const exclude = ["glm", "kimi", "k2p", "minimax", "qwen", "big-pickle", "hy3", "ring", "nemotron"];
  for (const e of exclude) { if (l.includes(e)) return false; }
  return l.includes("deepseek-v4") || l.includes("mimo");
}

function getThinkingModes(id: string): string[] {
  if (id.includes("deepseek-v4")) return ["LOW", "MEDIUM", "HIGH", "MAXIMUM"];
  if (id.includes("mimo") && supportsThinkingVariants(id)) return ["LOW", "MEDIUM", "HIGH"];
  return [];
}

let _ollamaModels: any[] | null = null;

async function buildOllamaModelList(): Promise<any[]> {
  if (_ollamaModels) return _ollamaModels;
  const ids = await initModels();
  const result: any[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const family = FAMILY_MAP[id] || id.split("-").slice(0, 2).join("-");
    const ctx = getModelCtx(id) || CAPABILITIES[id]?.length ? 128000 : 131072;
    const baseName = id.split("-").map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ").replace(/(\d)\.(\d)/g, "$1.$2");
    const displayName = `${baseName} [${formatContext(ctx)}]`;
    const entry = {
      name: displayName, model: `${id}:cloud`, remote_model: id,
      remote_host: "https://opencode.ai", modified_at: "2026-05-22T00:00:00+02:00",
      size: 384, digest: `sha256:${"0".repeat(64)}`,
      details: { parent_model: "", format: "", family, families: [family], parameter_size: "", quantization_level: "" },
    };
    if (!seen.has(entry.model)) { seen.add(entry.model); result.push(entry); }
    for (const mode of getThinkingModes(id)) {
      const tag = mode === "LOW" ? "LO" : mode === "MEDIUM" ? "MD" : mode === "HIGH" ? "HI" : "MX";
      const taggedId = `${id} [${tag}]`;
      const taggedModel = `${taggedId}:cloud`;
      if (!seen.has(taggedModel)) {
        seen.add(taggedModel);
        result.push({ ...entry, name: `${displayName} - ${mode.charAt(0) + mode.slice(1).toLowerCase()}`, model: taggedModel, id: taggedId });
      }
    }
  }
  _ollamaModels = result;
  return result;
}

export async function handleOllama(req: HandlerInput): Promise<HandlerResult> {
  const { method, url, body, headers, clientSocket } = req;
  const tag = agentTag(headers);
  const startTime = Date.now();

  if (method === "GET" && url === "/") {
    return { handled: true, response: { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: Buffer.from("Ollama is running") } };
  }

  if (method === "GET" && url === "/api/version") {
    return { handled: true, response: jsonResponse({ version: OLLAMA_VERSION }) };
  }

  if (method === "GET" && url === "/api/tags") {
    const models = await buildOllamaModelList();
    return { handled: true, response: jsonResponse({ models }) };
  }

  if (method === "POST" && url === "/api/show") {
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const raw = parsed.model || parsed.name || "";
    const { model: modelName, tag: thinkingTag } = parseThinkingTag(raw);
    const family = FAMILY_MAP[modelName] || modelName.split("-").slice(0, 2).join("-");
    const ctx = getModelCtx(modelName) || 131072;
    const caps = CAPABILITIES[modelName] || ["completion", "tools"];
    const modelInfo: any = {
      details: { parent_model: modelName, format: "", family, families: [family], parameter_size: "0", quantization_level: "" },
      model_info: { "general.architecture": family, [`${family}.context_length`]: ctx, "general.parameter_count": 0 },
      capabilities: caps, modified_at: "2026-05-22T00:00:00Z",
    };
    if (thinkingTag && THINKING_TAG_PARAMS[thinkingTag]) {
      modelInfo.model_info[`${family}.reasoning_effort`] = THINKING_TAG_PARAMS[thinkingTag];
    }
    return { handled: true, response: jsonResponse(modelInfo) };
  }

  if (method === "POST" && (url === "/api/chat" || url === "/api/generate")) {
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const rawModel = parsed.model || "";
    const { model: baseModel, tag: thinkingTag } = parseThinkingTag(rawModel);
    const model = normalizeToOpenCodeModel(baseModel);
    const isStream = parsed.stream !== false;
    const isGenerate = url === "/api/generate";

    const completeLog = reqLog({ tag, provider: "ollama", model, preview: (parsed.messages?.[0]?.content || parsed.prompt || "").slice(0, 100), body: parsed });

    if (isGenerate && parsed.prompt) {
      parsed.messages = [
        ...(parsed.system ? [{ role: "system", content: parsed.system }] : []),
        { role: "user", content: parsed.prompt },
      ];
    }

    const messages = (parsed.messages || []).map((m: any) => {
      const out: any = { role: m.role, content: m.content || "" };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      return out;
    });

    const tools = (parsed.tools || []).map((t: any) => ({
      type: "function",
      function: { name: t.function?.name || t.name || "unknown", description: t.function?.description || "", parameters: t.function?.parameters || t.parameters || {} },
    }));

    const extra: Record<string, any> = {};
    if (thinkingTag && THINKING_TAG_PARAMS[thinkingTag]) {
      extra.reasoningEffort = THINKING_TAG_PARAMS[thinkingTag];
    }
    if (parsed.options?.temperature != null) extra.temperature = parsed.options.temperature;
    if (parsed.options?.top_p != null) extra.top_p = parsed.options.top_p;
    if (parsed.options?.num_predict != null) extra.max_tokens = parsed.options.num_predict;
    else if (parsed.options?.max_tokens != null) extra.max_tokens = parsed.options.max_tokens;

    if (!messages.length) messages.push({ role: "user", content: "Hello" });

    try {
      const resp = await opencodeChat(model, messages, tools, isStream, extra);
      const elapsed = Date.now() - startTime;
      if (completeLog) completeLog(elapsed);

      if (!isStream) {
        const data: any = await resp.json();
        const choice = data.choices?.[0]?.message || {};
        const content = choice.content || "";
        if (content) storeReasoning(content.slice(0, 100), choice.reasoning_content || "");
        const ollamaResp: any = {
          model: rawModel, created_at: new Date().toISOString(),
          message: { role: "assistant", content },
          done: true, total_duration: elapsed * 1e6, load_duration: 0,
          prompt_eval_count: data.usage?.prompt_tokens || 0,
          eval_count: data.usage?.completion_tokens || content.length,
        };
        if (choice.tool_calls?.length) {
          ollamaResp.message.tool_calls = choice.tool_calls.map((tc: any) => ({
            id: tc.id, type: "function", function: { name: tc.function?.name, arguments: tc.function?.arguments },
          }));
        }
        if (isGenerate) {
          ollamaResp.response = content;
          delete ollamaResp.message;
        }
        return { handled: true, response: jsonResponse(ollamaResp) };
      }

      if (!clientSocket) return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };

      const head = `HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`;
      clientSocket.write(head);

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let contentAccum = "";
      let reasoningAccum = "";
      let toolCallsAccum: any[] = [];
      let promptTokens = 0;
      let evalCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("data: ") && t !== "data: [DONE]") {
            try {
              const d = JSON.parse(t.slice(6));
              const delta = d.choices?.[0]?.delta;
              if (delta?.content) {
                contentAccum += delta.content;
                const ndjson = { model: rawModel, created_at: new Date().toISOString(), done: false };
                if (isGenerate) { (ndjson as any).response = delta.content; }
                else { (ndjson as any).message = { role: "assistant", content: delta.content }; }
                clientSocket.write(JSON.stringify(ndjson) + "\n");
              }
              if (delta?.reasoning_content) {
                reasoningAccum += delta.reasoning_content;
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsAccum[idx]) toolCallsAccum[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                  if (tc.id) toolCallsAccum[idx].id = tc.id;
                  if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments;
                }
              }
              if (d.usage) {
                promptTokens = d.usage.prompt_tokens || 0;
                evalCount = d.usage.completion_tokens || 0;
              }
            } catch {}
          }
        }
      }

      const finalResp: any = {
        model: rawModel, created_at: new Date().toISOString(), done: true,
        total_duration: (Date.now() - startTime) * 1e6, load_duration: 0,
        prompt_eval_count: promptTokens || (isGenerate ? (parsed.prompt?.length || 0) : 0),
        eval_count: evalCount || contentAccum.length,
      };
      if (isGenerate) { finalResp.response = contentAccum; }
      else {
        finalResp.message = { role: "assistant", content: contentAccum };
        if (reasoningAccum) finalResp.message.reasoning_content = reasoningAccum;
        if (toolCallsAccum.length) {
          finalResp.message.tool_calls = toolCallsAccum.filter(Boolean).map((tc: any) => ({
            id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
      }
      if (contentAccum) storeReasoning(contentAccum.slice(0, 100), reasoningAccum);
      clientSocket.write(JSON.stringify(finalResp) + "\n");
      clientSocket.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    } catch (e: any) {
      if (completeLog) completeLog(Date.now() - startTime);
      if (isDebug()) console.log(`\n[OLLAMA] ${url} error: ${e.message}`);
      if (isStream && clientSocket) {
        const errResp = { model: rawModel, created_at: new Date().toISOString(), done: true, error: e.message };
        clientSocket.write(JSON.stringify(errResp) + "\n");
        clientSocket.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      return { handled: true, response: jsonResponse({ model: rawModel, created_at: new Date().toISOString(), done: true, error: e.message }) };
    }
  }

  if (method === "POST" && url === "/v1/chat/completions") {
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    const rawModel = parsed.model || "";
    const { model: baseModel, tag: thinkingTag } = parseThinkingTag(rawModel);
    const model = normalizeToOpenCodeModel(baseModel);
    const isStream = parsed.stream === true;
    const messages = parsed.messages || [];
    const tools = parsed.tools || [];

    const completeLog = reqLog({ tag, provider: "ollama-v1", model, preview: (messages.find((m: any) => m.role === "user")?.content || "").slice(0, 100), body: parsed });

    const extra: Record<string, any> = { ...parsed };
    delete extra.model; delete extra.messages; delete extra.tools; delete extra.stream;
    if (thinkingTag && THINKING_TAG_PARAMS[thinkingTag]) {
      extra.reasoningEffort = THINKING_TAG_PARAMS[thinkingTag];
    }

    try {
      const resp = await opencodeChat(model, messages, tools, isStream, extra);
      const elapsed = Date.now() - startTime;
      if (completeLog) completeLog(elapsed);

      if (!isStream) {
        const data: any = await resp.json();
        if (!data.system_fingerprint) data.system_fingerprint = "fp_ollama";
        return { handled: true, response: jsonResponse(data) };
      }

      if (!clientSocket) return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };

      const head = `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\nX-Accel-Buffering: no\r\n\r\n`;
      clientSocket.write(head);

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        clientSocket.write(decoder.decode(value, { stream: true }));
      }
      clientSocket.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    } catch (e: any) {
      if (completeLog) completeLog(Date.now() - startTime);
      if (isStream && clientSocket) {
        const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        clientSocket.write(`data: {"id":"${id}","object":"chat.completion.chunk","created":${Math.floor(Date.now() / 1000)},"model":"${model}","choices":[{"index":0,"delta":{"content":"Error: ${e.message}"},"finish_reason":"stop"}]}\n\n`);
        clientSocket.write("data: [DONE]\n\n");
        clientSocket.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      return { handled: true, response: jsonResponse({ error: e.message }, 500) };
    }
  }

  return { handled: false };
}
