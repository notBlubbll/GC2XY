import forge from "node-forge";
import { readFileSync } from "node:fs";
import { jsonResponse, HandlerInput, HandlerResult, countConsecutiveNags, stripNagMessages, RECENTLY_COMPLETED, RECENT_BODIES, injectIdentity, compactIdentity, scrubTaskComplete, compressToolDefinitions, stripCopilotGreeting } from "../../shared.ts";
import { chatCompletion as openAIChat, detectSessionSignal, extractUserPrompt, getModelDisplayName, getModelProviderTag } from "../openai-provider.ts";
import { chatCompletion as freebuffChat } from "../freebuff-client.ts";
import { chatCompletion as agnesChat } from "../agnes-client.ts";
import { chatCompletion as codestralChat } from "../codestral-client.ts";
import { chatCompletion as bitnetChat } from "../bitnet-client.ts";
import { chatCompletion as umansChat } from "../umans-client.ts";
import { addModels } from "../../models.ts";
import { handleVSModels, VS_MODELS } from "./models.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";
import { trackRequest } from "../../usage-tracker.ts";
import { anthropicToOpenAIRequest } from "../anthropic-bridge.ts";
import { filterModelsByConfig } from "../dashboard-handler.ts";

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
  if (model === "bitnet-demo" || model.startsWith("bitnet/")) return bitnetChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, ...extra });
  if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") return umansChat(model, messages, tools, stream, { ...extra });
  return openAIChat(model, messages, tools, stream, extra, session?.keyIdx, session?.sessionLabel);
}

import {
  repairToolCalls,
  detectApologyText,
  detectToolLoop,
  buildAnthropicTaskComplete,
  buildOpenAITaskComplete,
  bumpSalvageStat,
} from "../../tool-salvager.ts";

// ── Filename context extractor ─────────────────────────────────────────────
// When Agnes calls get_file/read_file with empty filename, extract the
// active file path from the conversation context that VS provides.
const _WINDOWS_PATH_RE = /([A-Z]:\\(?:[^"'\s,;}\])\\]+\\)*[^"'\s,;}\])\\]+\.\w+)/gi;
function _extractFilenameFromContext(messages: any[]): string {
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((c: any) => c.text || "").join(" ")
      : "";
    if (!text) continue;
    const matches = text.match(_WINDOWS_PATH_RE);
    if (matches?.length) return matches[matches.length - 1]; // last path = most specific
  }
  return "";
}
function _fixEmptyFilenames(repaired: any[], bridgeMessages: any[]): any[] {
  const ctx = _extractFilenameFromContext(bridgeMessages);
  if (!ctx) return repaired;
  return repaired.map((tc: any) => {
    const fn = tc.function || tc;
    if (/^(get_file|read_file)$/i.test(fn.name)) {
      let args: any = {};
      try { args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}"); } catch {}
      const hasFilename = (fn.name.toLowerCase() === "get_file")
        ? !!args.filename
        : !!args.filePath;
      if (!hasFilename) {
        if (fn.name.toLowerCase() === "get_file") args.filename = ctx;
        else args.filePath = ctx;
        console.log(`[TOOL SALVAGE] injected filename from context: ${ctx}`);
        return { ...tc, function: { ...fn, arguments: JSON.stringify(args) } };
      }
    }
    return tc;
  });
}

// ── Fix failed get_file tool_results ──────────────────────────────────────
// When VS's built-in get_file tool fails (e.g. "could not find a single file"),
// replace the error with actual file content read from disk.
function _fixFailedToolResults(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content) continue;
    const isGetFileFail = /could not find|file not found|not found|unable to find/i.test(content)
      && msg.tool_call_id;
    if (!isGetFileFail) continue;
    // Walk backwards to find the matching assistant tool_call
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role !== "assistant" || !prev.tool_calls?.length) continue;
      const tc = prev.tool_calls.find((t: any) => t.id === msg.tool_call_id);
      if (!tc) continue;
      const fn = tc.function || tc;
      if (!/^get_file$/i.test(fn.name)) continue;
      let args: any = {};
      try { args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}"); } catch {}
      const filePath = args.filename || args.filePath || args.path || "";
      if (!filePath) continue;
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        const ext = (filePath.split(".").pop() || "").toLowerCase();
        const langMap: Record<string, string> = { cs: "csharp", js: "javascript", ts: "typescript", py: "python", java: "java", cpp: "cpp", c: "c", h: "c", json: "json", xml: "xml", cshtml: "cshtml", razor: "cshtml", xaml: "xaml", sql: "sql", yaml: "yaml", yml: "yaml", md: "markdown", css: "css", scss: "scss", html: "html" };
        const lang = langMap[ext] || ext;
        const lines = fileContent.split("\n");
        const startLine = Math.max(1, args.startLine || 1);
        const endLine = Math.min(lines.length, args.endLine || lines.length);
        const sliced = lines.slice(startLine - 1, endLine);
        const numbered = sliced.map((l: string, idx: number) => `${startLine + idx}: ${l}`).join("\n");
        const fenced = "```" + lang + "\n" + numbered + "\n```";
        msg.content = fenced;
        console.log(`[TOOL SALVAGE] injected file content: ${filePath} (${sliced.length} lines)`);
      } catch (e: any) {
        console.log(`[TOOL SALVAGE] failed to read ${filePath}: ${e.message}`);
      }
      break;
    }
  }
}

// ── Tool-salvager output normalizer (Anthropic Messages response) ──
//
// Inspects the upstream OpenAI chat-completion `data` returned by the
// provider (after JSON parse), repairs each tool_call schema, detects
// apology/refusal text and stuck tool loops, and returns the final
// `data.choices[0].message` to render. Returns `null` if the caller
// should synthesize a task_complete SSE instead.
function _salvageAnthropicResponse(data: any, bridgeMessages: any[], model: string): {
  replacedWithTaskComplete: boolean;
  repairedCount: number;
  droppedCount: number;
  message: any;
} {
  const empty = { replacedWithTaskComplete: false, repairedCount: 0, droppedCount: 0, message: data?.choices?.[0]?.message || { role: "assistant", content: "" } };
  if (!data?.choices?.[0]) return { ...empty, replacedWithTaskComplete: true };

  const choice = data.choices[0];
  const msg = choice.message || { role: "assistant", content: "" };
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  // 1) Repair / salvage tool_calls
  const { repaired, dropped, total } = repairToolCalls(rawToolCalls);
  // 1b) Inject filename from conversation context for get_file/read_file with empty params
  const fixed = _fixEmptyFilenames(repaired, bridgeMessages);
  const finalRepaired = fixed;
  if (finalRepaired.length || dropped.length) {
    if (finalRepaired.length) bumpSalvageStat("normalized");
    if (dropped.length) bumpSalvageStat("dropped");
    if (finalRepaired.length !== total) {
      console.log(`[TOOL SALVAGE] ${model}: ${finalRepaired.length}/${total} tool_calls repaired, ${dropped.length} dropped`);
    }
  }

  // 2) Apology / refusal detection on the text content
  const apology = detectApologyText(rawContent);
  // 3) Tool-call loop detection (applies only when we have at least one
  //    tool_call AND prior messages already show the same tool fired N+ times)
  const loopCheck = finalRepaired.length
    ? detectToolLoop(
        bridgeMessages,
        { name: finalRepaired[0].function?.name || "", arguments: finalRepaired[0].function?.arguments || "{}" }
      )
    : { inLoop: false, count: 0, tool: "", args: "" };

  // If model is stuck in a loop OR apologizes AND has tool calls we
  // can't salvage, replace the entire response with a clean
  // task_complete so VS stops waiting.
  const allDropped = total > 0 && finalRepaired.length === 0;
  if ((apology && allDropped) || loopCheck.inLoop) {
    bumpSalvageStat(loopCheck.inLoop ? "loopInjected" : "apologyInjected");
    console.log(`[TOOL SALVAGE] ${model}: ${loopCheck.inLoop ? `loop(${loopCheck.tool}×${loopCheck.count})` : "apology"} → task_complete`);
    return { replacedWithTaskComplete: true, repairedCount: 0, droppedCount: total, message: null };
  }

  // If model apologizes WITH a real tool, prefer the tool — but log it
  if (apology) {
    bumpSalvageStat("apologyInjected");
    console.log(`[TOOL SALVAGE] ${model}: apology text kept alongside ${finalRepaired.length} tool_call(s) — VS will execute tools`);
  }

  return {
    replacedWithTaskComplete: false,
    repairedCount: finalRepaired.length,
    droppedCount: dropped.length,
    message: { ...msg, tool_calls: finalRepaired.length ? finalRepaired : undefined },
  };
}

const FAKE_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;
let _lastRealModel = "deepseek-v4-pro";

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

const THINKING_TAG_PARAMS: Record<string, Record<string, string>> = {
  LOW: { reasoningEffort: "low" },
  MEDIUM: { reasoningEffort: "medium" },
  HIGH: { reasoningEffort: "high" },
  MAXIMUM: { reasoningEffort: "max" },
  MED: { reasoningEffort: "medium" },
  MAX: { reasoningEffort: "max" },
};

function modelSupports(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const base: any = { parallel_tool_calls: true, streaming: true, tool_calls: true };
  if (isChat) base.structured_outputs = true;
  if (isChat) base.vision = true;
  const supportsDeepThink = l.includes("deepseek") || l.includes("claude") || l.includes("mimo") ||
    l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini")) || l.includes("big-pickle") || l.startsWith("umans-");
  if (supportsDeepThink) {
    base.adaptive_thinking = true;
    base.min_thinking_budget = 1024;
    base.max_thinking_budget = l.includes("big-pickle") ? 64000 : 32000;
  }
  if (l.includes("deepseek-v4")) {
    base.reasoning_effort = ["low", "medium", "high", "xhigh"];
  }
  if ((l.includes("mimo") && !supportsDeepThink) || l.startsWith("umans-")) {
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
  } else if (l.startsWith("umans-")) {
    limits.max_context_window_tokens = 256000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 200000; limits.max_non_streaming_output_tokens = 16000;
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
  let models = await addModels();
  models = filterModelsByConfig(models);

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
  // Handle -lo, -md, -hi, -mx suffix (appended to model ID in VS model list)
  const suffixMatch = clean.match(/^(.+?)-(lo|md|hi|mx)$/i);
  if (suffixMatch) {
    const SUFFIX_MAP: Record<string, string> = { LO: "LOW", MD: "MEDIUM", HI: "HIGH", MX: "MAXIMUM" };
    const raw = suffixMatch[2].toUpperCase();
    return { model: suffixMatch[1].trim(), thinking: SUFFIX_MAP[raw] };
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

    // ── VS retry dedup: same model+prompt within 5s → empty stop ──
    const _lastUser = [..._v1NagMessages].reverse().find((m: any) => m.role === "user");
    const _prompt = typeof _lastUser?.content === "string" ? _lastUser.content.slice(-200) :
      Array.isArray(_lastUser?.content) ? _lastUser.content.map((c: any) => c.text || "").join("").slice(-200) : "";
    const _vsDedupKey = `${_v1NagModel}:${_prompt}`;
    if (_prompt && (RECENT_BODIES.get(_vsDedupKey) ?? 0) && Date.now() - (RECENT_BODIES.get(_vsDedupKey) ?? 0) < 5000) {
      const _id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
      const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: _id, type: "message", role: "assistant", content: [], model: _v1NagModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
    }
    // Mark dedup timestamp so retries within 5s are caught
    if (_prompt) RECENT_BODIES.set(_vsDedupKey, Date.now());

    // ── Nag: drain → empty stop, nag → task_complete (agentic mode only) ──
    const _v1Initiator = headers["x-initiator"] || "";
    const _isAgentic = _v1Initiator === "agent";
    const _nagCount = _isAgentic ? countConsecutiveNags(_v1NagMessages) : 0;
    if (_isAgentic && RECENTLY_COMPLETED.get(_v1NagModel) && Date.now() - RECENTLY_COMPLETED.get(_v1NagModel) < 20000) {
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
    if (model.startsWith("_sep_") || model.startsWith("cat_") || model.startsWith("_cat_")) {
      const catTag = model.replace(/^_?(?:sep|cat)_/, "");
      const catModel = FAKE_MODELS.find((m: any) => getModelProviderTag(m.id) === catTag);
      if (catModel) {
        model = catModel.id;
      } else {
        model = FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : _lastRealModel;
      }
      console.log(`[CAT MODEL] /v1/messages routing ${model} ← category ${catTag}`);
    }
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
    if (!FAKE_MODELS.find((m: any) => m.id === model) && !isProviderRouted(model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/MESSAGES] ${model} not found, picked ${model}`);
    }
    _lastRealModel = model;

    let startTime = Date.now();
    let messagesComplete: any;
    try {
      parsed.model = model;
      const bridge = anthropicToOpenAIRequest(parsed);

      injectIdentity(bridge.messages, getModelDisplayName(model), model, parsedTag.thinking || undefined);

      const scrubbed = scrubTaskComplete(bridge.messages, bridge.tools);
      bridge.messages = scrubbed.messages;
      bridge.tools = scrubbed.tools;
      _fixFailedToolResults(bridge.messages);
      bridge.tools = compressToolDefinitions(bridge.tools);

      // Add tool reminder to prevent missing required parameters
      if (bridge.tools?.length) {
        const toolReminder = "\n\nCRITICAL TOOL RULE: When calling any tool, you MUST include ALL required parameters from the tool schema. Missing required parameters (like filePath for create_file) will cause failures. Always verify your tool call includes every required field.";
        // Append to the identity system message or create a new one
        const hasSystem = bridge.messages.some((m: any) => m.role === "system");
        if (hasSystem) {
          for (const m of bridge.messages) {
            if (m.role === "system") {
              m.content += toolReminder;
              break;
            }
          }
        } else {
          bridge.messages.unshift({ role: "system", content: toolReminder });
        }
      }

      const vsSession = detectSessionSignal(bridge.messages);
      if (vsSession) {
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[VS SESSION] ${ts} [Session#${vsSession.sessNum}>${vsSession.keyLabel}] ${model} "${extractUserPrompt(bridge.messages).substring(0, 120)}"`);
      }

      const lastUserMsg = [...bridge.messages].reverse().find((m: any) => m.role === "user");
      const vsTag = agentTag(headers);
      const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "go";
      const messagesPreview = lastUserMsg ? (
        typeof lastUserMsg.content === "string" ? lastUserMsg.content :
        Array.isArray(lastUserMsg.content) ? lastUserMsg.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join(" ") : ""
      ) : "";
      const messagesComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: messagesPreview, body: parsed });

      const resp = await routeChat(bridge.model, bridge.messages, bridge.tools, bridge.stream, {
        max_tokens: bridge.max_tokens,
        ...parsed,
      }, vsSession);

      const respCt = resp.headers.get("content-type") || "";
      const actualStream = isStream && respCt.includes("event-stream");
      if (!actualStream) {
        const openaiData: any = await resp.json();
        const elapsed = Date.now() - startTime;
        if (messagesComplete) messagesComplete(elapsed);
        const choice = openaiData.choices?.[0]?.message;
        const content = stripCopilotGreeting(choice?.content || "");
        const toolCalls = choice?.tool_calls;

        // ── Tool salvager: repair, detect apology, detect loop ──
        const salvaged = _salvageAnthropicResponse(openaiData, bridge.messages, model);
        if (salvaged.replacedWithTaskComplete) {
          const sse = buildAnthropicTaskComplete(model);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sse) } };
        }
        const repairedChoice = salvaged.message;
        const repairedContent = typeof repairedChoice.content === "string" ? repairedChoice.content : content;
        const repairedToolCalls = Array.isArray(repairedChoice.tool_calls) ? repairedChoice.tool_calls : toolCalls;

        const contentBlocks: any[] = [{ type: "text", text: repairedContent }];
        let stopReason = "end_turn";
        if (repairedToolCalls?.length) {
          for (const tc of repairedToolCalls) {
            const fn = tc.function || tc;
            let args: any = {};
            try { args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}"); } catch {}
            contentBlocks.push({ type: "tool_use", id: tc.id, name: fn.name || "unknown", input: args });
          }
          stopReason = "tool_use";
        }

        if (isStream) {
          const msgId = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
          const usage = openaiData.usage || {};
          if (usage.output_tokens === undefined) usage.output_tokens = 0;
          if (usage.input_tokens === undefined) usage.input_tokens = 0;
          const sseChunks: string[] = [];
          sseChunks.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } })}\n\n`);
          let idx = 0;
          for (const block of contentBlocks) {
            if (block.type === "tool_use") {
              sseChunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n`);
              const inputJson = JSON.stringify(block.input || {});
              sseChunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: inputJson } })}\n\n`);
              sseChunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
            } else {
              sseChunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: block })}\n\n`);
              sseChunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
            }
            idx++;
          }
          sseChunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } })}\n\n`);
          sseChunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          const sseBody = sseChunks.join("");
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(sseBody) } };
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
        let greetingBuf = "";
        let greetingDone = false;

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
                  if (!greetingDone) {
                    greetingBuf += delta.content;
                    const stripped = stripCopilotGreeting(greetingBuf);
                    if (stripped.length !== greetingBuf.length || greetingBuf.length >= 200) {
                      greetingDone = true;
                      if (stripped.length > 0) {
                        fullContent += stripped;
                        sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: stripped } });
                      }
                    }
  } else if (l.startsWith("umans-")) {
    limits.max_context_window_tokens = 256000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 200000; limits.max_non_streaming_output_tokens = 16000;
  } else {
                    fullContent += delta.content;
                    sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: delta.content } });
                  }
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
        const tcKeys = Object.keys(toolCallAccum);
        if (tcKeys.length > 0) {
          const names = tcKeys.map(k => `${toolCallAccum[k].name}(${toolCallAccum[k].args.length}a)`).join(",");
          console.log(`[VS STREAM] tool_calls accumulated: [${names}]`);
        }

        // ── Tool salvager (streaming path) ──
        // Repair accumulated tool_calls before forwarding as tool_use blocks.
        // Also detect apology text in `fullContent` and tool-call loops in
        // `bridge.messages` — if either fires, swap the entire response for
        // a clean task_complete SSE so VS stops waiting.
        const _streamToolCalls = tcKeys.map((k) => {
          const a = toolCallAccum[+k];
          return {
            id: a.id,
            type: "function",
            function: { name: a.name, arguments: a.args },
          };
        });
        const { repaired: _streamRepaired, dropped: _streamDropped } = repairToolCalls(_streamToolCalls);
        const _streamFixed = _fixEmptyFilenames(_streamRepaired, bridge.messages);
        if (_streamDropped.length) bumpSalvageStat("dropped");
        if (_streamFixed.length !== _streamToolCalls.length) {
          console.log(`[TOOL SALVAGE] ${model} (stream): ${_streamFixed.length}/${_streamToolCalls.length} tool_calls repaired, ${_streamDropped.length} dropped`);
        }
        const _streamApology = detectApologyText(fullContent);
        const _streamLoop = _streamFixed.length
          ? detectToolLoop(
              bridge.messages,
              { name: _streamFixed[0].function?.name || "", arguments: _streamFixed[0].function?.arguments || "{}" }
            )
          : { inLoop: false, count: 0, tool: "", args: "" };
        const _streamAllDropped = _streamToolCalls.length > 0 && _streamFixed.length === 0;
        if ((_streamApology && _streamAllDropped) || _streamLoop.inLoop) {
          bumpSalvageStat(_streamLoop.inLoop ? "loopInjected" : "apologyInjected");
          console.log(`[TOOL SALVAGE] ${model} (stream): ${_streamLoop.inLoop ? `loop(${_streamLoop.tool}×${_streamLoop.count})` : "apology"} → task_complete`);
          try { sock.write(buildAnthropicTaskComplete(model)); } catch {}
          try { sock.end(); } catch {}
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
        // Apply repaired tool_calls back to the accumulator (for loop counter consistency)
        for (let i = 0; i < _streamFixed.length && i < tcKeys.length; i++) {
          const a = toolCallAccum[+tcKeys[i]];
          const r = _streamFixed[i].function || {};
          a.name = r.name || a.name;
          a.args = r.arguments || a.args;
        }

        const toolBlockStartIdx = 1;
        for (let i = 0; i < tcKeys.length; i++) {
          sseEvent(sock, "content_block_stop", { type: "content_block_stop", index: toolBlockStartIdx + i });
        }

        const hasToolCalls = tcKeys.length > 0;
        const actualStopReason = hasToolCalls ? "tool_use" : "end_turn";
        sseEvent(sock, "message_delta", { type: "message_delta", delta: { stop_reason: actualStopReason, stop_sequence: null }, usage: { output_tokens: fullContent.length } });
        sseEvent(sock, "message_stop", { type: "message_stop" });
        try { sock.end(); } catch {}
        const elapsed = Date.now() - startTime;
        if (messagesComplete) messagesComplete(elapsed);

        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      const elapsed = Date.now() - startTime;
      if (messagesComplete) messagesComplete(elapsed);
      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      if (messagesComplete) messagesComplete(elapsed);
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
    if (model.startsWith("_sep_") || model.startsWith("cat_") || model.startsWith("_cat_")) {
      const catTag = model.replace(/^_?(?:sep|cat)_/, "");
      const catModel = FAKE_MODELS.find((m: any) => getModelProviderTag(m.id) === catTag);
      if (catModel) {
        model = catModel.id;
        console.log(`[CAT MODEL] /responses routing ${model} ← category ${catTag}`);
      } else {
        model = FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : _lastRealModel;
        console.log(`[CAT MODEL] /responses fallback to ${model}`);
      }
    }
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
    if (!FAKE_MODELS.find((m: any) => m.id === model) && !isProviderRouted(model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/RESPONSES] ${model} not found, picked ${model}`);
    }
    _lastRealModel = model;

    let startTime = Date.now();
    let responsesComplete: any;
    try {
      const identityText = compactIdentity(getModelDisplayName(model), model, parsedTag.thinking || undefined);
      const messages = [
        { role: "system", content: identityText + (instructions ? "\n\n" + instructions : "") },
        { role: "user", content: userContent },
      ];

      const scrubbedResp = scrubTaskComplete(messages, tools);
      const cleanMessages = scrubbedResp.messages;
      const cleanTools = scrubbedResp.tools;
      const cleanToolsBn = compressToolDefinitions(cleanTools);

      const vsSession = detectSessionSignal(cleanMessages);
      if (vsSession) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[VS SESSION] ${ts2} [Session#${vsSession.sessNum}>${vsSession.keyLabel}] ${model} "${extractUserPrompt(cleanMessages).substring(0, 120)}"`);
      }

    const vsTag = agentTag(headers);
    const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "go";

    const resp = await routeChat(model, cleanMessages, cleanToolsBn, isStream, { ...parsed }, vsSession);
      if (!isStream) {
        const openaiData: any = await resp.json();
        if (openaiData?.choices?.[0]?.message?.content) {
          openaiData.choices[0].message.content = stripCopilotGreeting(openaiData.choices[0].message.content);
        }
        const elapsed = Date.now() - startTime;
        if (responsesComplete) responsesComplete(elapsed);
        // ── Tool salvager (OpenAI Responses API path) ──
        const salvaged = _salvageAnthropicResponse(openaiData, cleanMessages, model);
        if (salvaged.replacedWithTaskComplete) {
          return { handled: true, response: jsonResponse(buildOpenAITaskComplete(model)) };
        }
        if (salvaged.repairedCount || salvaged.droppedCount) {
          openaiData.choices = openaiData.choices || [{}];
          openaiData.choices[0].message = salvaged.message;
        }
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
      const elapsed = Date.now() - startTime;
      if (responsesComplete) responsesComplete(elapsed);
      return { handled: true, response: jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: `Mock response (upstream: ${e.message})` }, finish_reason: "stop" }] })};
    }
  }

  // POST /chat/completions - VS sends OpenAI chat format too
  if (method === "POST" && url.includes("/chat/completions")) { trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const messages = parsed.messages || [];

    // ── VS retry dedup: same model+prompt within 5s → empty stop ──
    const _chatLastUser = [...messages].reverse().find((m: any) => m.role === "user");
    const _chatPrompt = typeof _chatLastUser?.content === "string" ? _chatLastUser.content.slice(-200) :
      Array.isArray(_chatLastUser?.content) ? _chatLastUser.content.map((c: any) => c.text || "").join("").slice(-200) : "";
    const _chatDedupKey = `${model}:${_chatPrompt}`;
    if (_chatPrompt && (RECENT_BODIES.get(_chatDedupKey) ?? 0) && Date.now() - (RECENT_BODIES.get(_chatDedupKey) ?? 0) < 5000) {
      const _cid = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
      return { handled: true, response: jsonResponse({ id: _cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) };
    }
    if (_chatPrompt) RECENT_BODIES.set(_chatDedupKey, Date.now());

    const isStream = parsed.stream === true;
    const tools = parsed.tools || [];
    const maxTokens = parsed.max_tokens || 4096;

    await ensureModels();
    const parsedTag = parseThinkingMode(model);
    model = parsedTag.model;
    if (model.startsWith("_sep_") || model.startsWith("cat_") || model.startsWith("_cat_")) {
      const catTag = model.replace(/^_?(?:sep|cat)_/, "");
      const catModel = FAKE_MODELS.find((m: any) => getModelProviderTag(m.id) === catTag);
      if (catModel) {
        model = catModel.id;
        console.log(`[CAT MODEL] /chat/completions routing ${model} ← category ${catTag}`);
      } else {
        model = FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : _lastRealModel;
        console.log(`[CAT MODEL] /chat/completions fallback to ${model}`);
      }
    }
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
    if (!FAKE_MODELS.find((m: any) => m.id === model) && !isProviderRouted(model)) {
      const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
      model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      console.log(`[MODEL VS/CHAT] ${model} not found, picked ${model}`);
    }
    _lastRealModel = model;

    // Sanitize tools: remove entries with empty function names
    const cleanTools = (tools || []).filter((t: any) => {
      const fn = t.function || t;
      return fn.name && fn.name.length > 0;
    });

    if (!messages.length) {
      messages.push({ role: "user", content: "Hello" });
    }

    injectIdentity(messages, getModelDisplayName(model), model, parsedTag.thinking || undefined);

    const scrubbedChat = scrubTaskComplete(messages, cleanTools);
    const chatMessages = scrubbedChat.messages;
    const chatTools = scrubbedChat.tools;
    const chatToolsBn = compressToolDefinitions(chatTools);

    // Session tracking
    const session = detectSessionSignal(chatMessages);
    let sessionLabel = "";
    if (session) {
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      sessionLabel = `[Session#${session.sessNum}>${session.keyLabel}]`;
      console.log(`[VS SESSION] ${ts} ${sessionLabel} ${model} "${extractUserPrompt(chatMessages).substring(0, 120)}"`);
    }

    // Nag detection for /chat/completions — only in agentic mode (x-initiator: agent)
    const _chatInitiator = headers["x-initiator"] || "";
    const _nagLastUser = [...chatMessages].reverse().find((m: any) => m.role === "user") || chatMessages[chatMessages.length - 1];
    const _chatContent = _extractText(_nagLastUser?.content);
    if (_chatInitiator === "agent" && _chatContent && /not yet marked/i.test(_chatContent)) {
      console.log(`[VS NAG] Auto task_complete via /chat/completions (agentic)`);
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
      const lastUserMsg = [...chatMessages].reverse().find((m: any) => m.role === "user");
      const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "go";

      const isUm3 = model.startsWith("umans-");
      const resp = await routeChat(model, chatMessages, chatToolsBn, isStream, { max_tokens: maxTokens, ...parsed }, session);
      if (!isStream) {
        const data: any = await resp.json();
        if (data?.choices?.[0]?.message?.content) {
          data.choices[0].message.content = stripCopilotGreeting(data.choices[0].message.content);
        }
        recordTps(data.usage?.completion_tokens || (data.choices?.[0]?.message?.content || "").length, Date.now() - vsReqStart);
        if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
        // ── Tool salvager (OpenAI Chat Completions path) ──
        const salvaged = _salvageAnthropicResponse(data, chatMessages, model);
        if (salvaged.replacedWithTaskComplete) {
          return { handled: true, response: jsonResponse(buildOpenAITaskComplete(model)) };
        }
        if (salvaged.repairedCount || salvaged.droppedCount) {
          data.choices = data.choices || [{}];
          data.choices[0].message = salvaged.message;
        }
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

