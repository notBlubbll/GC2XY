import forge from "node-forge";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { jsonResponse, HandlerInput, HandlerResult, countConsecutiveNags, stripNagMessages, RECENTLY_COMPLETED, RECENT_BODIES, injectIdentity, compactIdentity, scrubTaskComplete, compressToolDefinitions, stripCopilotGreeting, getProjectRoot, normalizeToolCallId, safePreviewFromContent } from "../../shared.ts";
import { chatCompletion as openAIChat, detectSessionSignal, extractUserPrompt, getModelDisplayName, getModelProviderTag } from "../openai-provider.ts";
import { buildResponsesFromChatCompletion, streamChatCompletionToResponses, streamResponsesObjectToSSE, flattenResponsesInput, ResponsesOptions } from "./response-converter.ts";
import { StreamResponseLogger } from "../../streaming-log.ts";

// Dedicated /responses debug logger, because streamed responses bypass the traffic log.
import { join } from "node:path";
const VS_RESP_LOG_PATH = join(process.env.LOG_DIR || join(getProjectRoot(), ".proxy-logs"), "vs-responses.log");
function vsRespLog(line: string) {
  try {
    appendFileSync(VS_RESP_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function buildQuotaSnapshotHeaders(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const rst = nextMonth.toISOString();
  const chatEnt = 500, chatRem = 290, chatPct = 58;
  const compEnt = 4000, compRem = 2320, compPct = 58;
  const premEnt = 1000, premRem = 580, premPct = 58;
  return [
    `x-quota-snapshot-chat: ent=${chatEnt}&ov=0.0&ovPerm=false&rem=${chatPct}.0&rst=${rst}&totRem=${chatRem}.0\r\n`,
    `x-quota-snapshot-completions: ent=${compEnt}&ov=0.0&ovPerm=false&rem=${compPct}.0&rst=${rst}&totRem=${compRem}.0\r\n`,
    `x-quota-snapshot-premium_interactions: ent=${premEnt}&ov=0.0&ovPerm=false&rem=${premPct}.0&rst=${rst}&totRem=${premRem}.0\r\n`,
  ].join("");
}

async function responseBodyToString(resp: Response): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}
import { chatCompletion as freebuffChat } from "../freebuff-client.ts";
import { chatCompletion as agnesChat } from "../agnes-client.ts";
import { chatCompletion as codestralChat } from "../codestral-client.ts";
import { chatCompletion as bitnetChat } from "../bitnet-client.ts";
import { chatCompletion as umansChat, anthropicChatCompletion as umansAnthropicChat } from "../umans-client.ts";
import { addModels } from "../../models.ts";
import { handleVSModels, VS_MODELS } from "./models.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";
import { trackRequest } from "../../usage-tracker.ts";
import { appendFileSync } from "node:fs";
import { getVsLegacyModel } from "../dashboard-handler.ts";
import { getProjectRoot } from "../../shared.ts";
import { anthropicToOpenAIRequest } from "../anthropic-bridge.ts";
import { filterModelsByConfig } from "../../shared.ts";

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
  // OC-GO upstream removed — unknown/unprefixed models are rejected.
  return openAIChat(model, messages, tools, stream, extra, session?.keyIdx, session?.sessionLabel);
}

function normalizeModelIdVs(model: string): string {
  // Hard strip anything VS may have appended (thinking tag, slug, clone suffix)
  let m = model.trim();
  const suffixMatch = m.match(/^(.*?)(?:\s*\[(LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX|LO|MD|HI|MX)\]\s*|\s*-(lo|md|hi|mx))$/i);
  if (suffixMatch) m = suffixMatch[1].trim();
  return m;
}

async function resolveActiveChatModel(model: string): Promise<string> {
  const normalized = normalizeModelIdVs(model);
  // VS 2022 (17.x) legacy: always use the configured legacy model when set
  const legacyModel = getVsLegacyModel();
  if (legacyModel) return legacyModel;
  if (isProviderRouted(normalized)) return normalized;
  // model is unknown / not among configured providers → pick a real default
  try {
    let ids = await addModels();
    ids = filterModelsByConfig(ids);
    const chatIds = ids.filter((id: string) => {
      const l = id.toLowerCase();
      return !l.includes("embedding") && !l.includes("ada");
    });
    // prefer umans, then agnes, then codestral, then freebuff, then anything
    const preferred = ["umans", "agnes", "codestral", "freebuff"];
    for (const tag of preferred) {
      const pick = chatIds.find((id: string) => getModelProviderTag(id) === tag);
      if (pick) return pick;
    }
    return chatIds[0] || model;
  } catch { }
  return model;
}

async function routeChatWithFallback(
  model: string,
  messages: any[],
  tools: any[] | undefined,
  stream: boolean,
  extra: Record<string, any>,
  session?: { keyIdx?: number; sessionLabel?: string }
): Promise<{ response: Response; model: string }> {
  const resolved = await resolveActiveChatModel(model);
  const resp = await routeChat(resolved, messages, tools, stream, extra, session);
  return { response: resp, model: resolved };
}

function buildAnthropicTextSse(model: string, text: string): string {
  const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  const chunks: string[] = [];
  chunks.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
  chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
  chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  chunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
  chunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return chunks.join("");
}

import {
  repairToolCalls,
  detectApologyText,
  detectToolLoop,
  buildAnthropicTaskComplete,
  buildOpenAITaskComplete,
  bumpSalvageStat,
  extractNameFromToolId,
} from "../../tool-salvager.ts";

// ── Filename context extractor ─────────────────────────────────────────────
// When Agnes calls get_file/read_file with empty filename, extract the
// active file path from the conversation context that VS provides.
const _WINDOWS_PATH_RE = /([A-Z]:\\(?:[^"'\s,;}\])\\]+\\)*[^"'\s,;}\])\\]+\.\w+)/gi;
function _extractFilenameFromContext(messages: any[]): string {
  for (const m of messages) {
    const text = safePreviewFromContent(m.content);
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

function normalizeToolChoice(tc: any): string | undefined {
  if (tc === undefined || tc === null) return undefined;
  if (typeof tc === "string") return tc;
  if (typeof tc === "object" && tc.type) {
    if (tc.type === "function" && tc.function?.name) return tc;
    return tc.type;
  }
  return tc;
}

function buildAnthropicErrorSSE(model: string, status: number, errorBody: string): string {
  const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `[Error] Upstream returned ${status}: ${errorBody}` } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
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
  if (!data?.choices?.[0]) {
    console.log(`[TOOL SALVAGE] ${model}: no choices in upstream response, returning empty text (not task_complete)`);
    return { ...empty, replacedWithTaskComplete: false };
  }

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

      supported_endpoints: ["/chat/completions", "/v1/messages", "/responses", "ws:/responses"],
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
  const ua = (headers["user-agent"] || "").toLowerCase();
  const isVisualStudio = editorVersion.startsWith("VS/VisualStudio") || /^VS\/\d/.test(editorVersion) || editorVersion.startsWith("VS/SSMS") || ua.includes("vsteamexplorer");

  if (!isVisualStudio) return { handled: false };

  console.log(`[VISUAL STUDIO] ${method} ${url} (editor: ${editorVersion})`);

  // POST /v1/messages - Visual Studio Copilot chat endpoint (Anthropic Messages API)
  if (method === "POST" && url === "/v1/messages") { trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    // Diagnostic: log raw incoming body for VS /v1/messages
    const v1LogPath = `${getProjectRoot()}/.proxy-logs/vs-messages.log`;
    const v1Log = (entry: any) => { try { appendFileSync(v1LogPath, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`); } catch {} };
    v1Log({ type: "raw-in", model: parsed.model, messagesSummary: (parsed.messages || []).map((m:any)=>({role:m.role, contentLen: typeof m.content==='string'?m.content.length:Array.isArray(m.content)?m.content.length:0})), systemType: typeof parsed.system, stream: parsed.stream, toolsCount: (parsed.tools||[]).length });
    const _v1NagModel = parsed.model || "";
    const _v1NagMessages = parsed.messages || [];

    // ── VS retry dedup: same model+prompt within 5s → empty stop ──
    const _lastUser = [..._v1NagMessages].reverse().find((m: any) => m.role === "user");
    const _prompt = safePreviewFromContent(_lastUser?.content).slice(-200);
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
      console.log(`[VS NAG] ${_v1NagModel}: ${_nagCount} consecutive nag(s) → task_complete`);
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
      const origModel = model;
      if (!model && _lastRealModel) {
        model = _lastRealModel;
      } else {
        const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
        model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      }
      console.log(`[MODEL VS/MESSAGES] ${origModel || "(empty)"} not found, picked ${model}`);
    }
    _lastRealModel = model;

    let startTime = Date.now();
    let messagesComplete: any;
    try {
      parsed.model = model;

      // ── Native UMANS Anthropic pass-through ───────────────────────────
      // UMANS upstream natively supports /messages, so when the routed model is
      // a UMANS model we skip the anthropic-bridge translation entirely and
      // forward the Anthropic payload directly. The response is already in
      // Anthropic SSE/JSON format — no OpenAI→Anthropic conversion needed.
      if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") {
        const vsTag = agentTag(headers);
        const _lastUser = [...(parsed.messages || [])].reverse().find((m: any) => m.role === "user");
        const _preview = _lastUser ? safePreviewFromContent(_lastUser.content) : "";
        const _mc = reqLog({ tag: vsTag, provider: "umans", model, preview: _preview, body: parsed });
        v1Log({ type: "native-anthropic", resolved: model, stream: parsed.stream });
        const resp = await umansAnthropicChat(parsed);
        const respCt = resp.headers.get("content-type") || (parsed.stream ? "text/event-stream" : "application/json");
        console.log(`[VS MESSAGES] native-umans req=${model} status=${resp.status} ct=${respCt}`);
        if (resp.status >= 400) {
          const errText = await resp.text().catch(() => "");
          v1Log({ type: "native-anthropic-error", status: resp.status, body: errText.slice(0, 500) });
          const errSse = buildAnthropicErrorSSE(model, resp.status, errText.length > 500 ? errText.slice(0, 500) + "..." : errText);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(errSse) } };
        }
        if (_mc) _mc(Date.now() - startTime);
        const buf = Buffer.from(await resp.arrayBuffer());
        return { handled: true, response: { statusCode: resp.status, headers: { "content-type": respCt, "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: buf } };
      }

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
      const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";
      const messagesPreview = lastUserMsg ? safePreviewFromContent(lastUserMsg.content) : "";
      const messagesComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: messagesPreview, body: parsed });

      v1Log({ type: "bridge", model: bridge.model, messages: bridge.messages.slice(-3), toolsCount: (bridge.tools || []).length, stream: bridge.stream, max_tokens: bridge.max_tokens });

      const bridgeExtras: Record<string, any> = { max_tokens: bridge.max_tokens };
      if (parsed.reasoning) bridgeExtras.reasoning = parsed.reasoning;
      if (parsed.temperature !== undefined) bridgeExtras.temperature = parsed.temperature;
      if (parsed.top_p !== undefined) bridgeExtras.top_p = parsed.top_p;
      if (parsed.tool_choice !== undefined) bridgeExtras.tool_choice = normalizeToolChoice(parsed.tool_choice);
      if (parsed.parallel_tool_calls !== undefined) bridgeExtras.parallel_tool_calls = parsed.parallel_tool_calls;
      if (parsed.max_output_tokens !== undefined) bridgeExtras.max_output_tokens = parsed.max_output_tokens;
      if (parsed.text !== undefined) bridgeExtras.text = parsed.text;
      if (parsed.store !== undefined) bridgeExtras.store = parsed.store;
      if (parsed.presence_penalty !== undefined) bridgeExtras.presence_penalty = parsed.presence_penalty;
      if (parsed.frequency_penalty !== undefined) bridgeExtras.frequency_penalty = parsed.frequency_penalty;
      if (parsed.stop !== undefined) bridgeExtras.stop = parsed.stop;
      const fallbackRouted = await routeChatWithFallback(bridge.model, bridge.messages, bridge.tools, bridge.stream, bridgeExtras, vsSession);
      let resp = fallbackRouted.response;
      console.log(`[VS MESSAGES] req=${bridge.model} resolved=${fallbackRouted.model} status=${resp.status} ct=${resp.headers.get("content-type") || ""}`);
      v1Log({ type: "route", resolved: fallbackRouted.model, status: resp.status, ct: resp.headers.get("content-type") || "" });

      const respCt = resp.headers.get("content-type") || "";
      const actualStream = isStream && respCt.includes("event-stream");
      if (!actualStream) {
        const rawText = await resp.text();
        if (resp.status >= 400) {
          console.log(`[VS MESSAGES] upstream error ${resp.status}: ${rawText.slice(0, 500)}`);
          v1Log({ type: "upstream-error", status: resp.status, body: rawText.slice(0, 500) });
          const errMsg = rawText.length > 500 ? rawText.slice(0, 500) + "..." : rawText;
          const errSse = buildAnthropicErrorSSE(model, resp.status, errMsg);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(errSse) } };
        }
        let openaiData: any;
        try { openaiData = JSON.parse(rawText); } catch (e: any) {
          console.log(`[VS MESSAGES] upstream non-JSON (${resp.status}): ${rawText.slice(0, 300)}`);
          const errSse = buildAnthropicErrorSSE(model, resp.status, rawText.slice(0, 500));
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "access-control-allow-origin": "*", "connection": "close" }, body: Buffer.from(errSse) } };
        }
        const elapsed = Date.now() - startTime;
        if (messagesComplete) messagesComplete(elapsed);
        const choice = openaiData.choices?.[0]?.message;
        const content = stripCopilotGreeting(choice?.content || "");
        const toolCalls = choice?.tool_calls;
        v1Log({ type: "upstream-json", model: fallbackRouted.model, content: content.slice(0, 500), finish: openaiData.choices?.[0]?.finish_reason, usage: openaiData.usage });

        // ── Tool salvager: repair, detect apology, detect loop ──
        const salvaged = _salvageAnthropicResponse(openaiData, bridge.messages, model);
        if (salvaged.replacedWithTaskComplete) {
          console.log(`[VS MESSAGES] salvager replaced response with task_complete for ${model}`);
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
            contentBlocks.push({ type: "tool_use", id: normalizeToolCallId(tc.id, "anthropic"), name: fn.name || extractNameFromToolId(tc.id) || "unknown", input: args });
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
        const v1SvcReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-copilot-service-request-id: ${v1SvcReqId}\r\nconnection: close\r\n\r\n`;
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

        const streamLog = new StreamResponseLogger({ endpoint: "/v1/messages", model, resolved: fallbackRouted.model, status: resp.status });

        sseEvent(sock, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        sseEvent(sock, "content_block_start", { type: "content_block_start", index: nextContentIdx, content_block: { type: "text", text: "" } });

        let firstChunkSeen = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!firstChunkSeen) { v1Log({ type: "upstream-stream-first", model: fallbackRouted.model, chunk: chunk.slice(0, 400) }); firstChunkSeen = true; }
          const lines = chunk.split("\n");
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              try {
                const d = JSON.parse(t.slice(6));
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) {
                  streamLog.addContent(delta.content);
                  if (!greetingDone) {
                    greetingBuf += delta.content;
                    const stripped = stripCopilotGreeting(greetingBuf);
                    const finishReason = d.choices?.[0]?.finish_reason;
                    // Flush greeting buffer when: greeting matched, buffer exceeds
                    // 200 chars, OR the upstream signaled completion (short
                    // single-chunk responses from agnes/bitnet/etc. would
                    // otherwise be trapped in greetingBuf and never forwarded).
                    if (stripped.length !== greetingBuf.length || greetingBuf.length >= 200 || finishReason) {
                      greetingDone = true;
                      if (stripped.length > 0) {
                        fullContent += stripped;
                        sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: stripped } });
                      }
                    }
                  } else {
                    fullContent += delta.content;
                    sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: delta.content } });
                  }
                }
                if (delta?.reasoning_content) {
                  streamLog.addReasoning(delta.reasoning_content);
                  // Reasoning always goes as reasoning_delta — never as text.
                  // The old code emitted reasoning as text_delta when it arrived
                  // first, which leaked "The user said..." reasoning into VS chat.
                  greetingDone = true;
                  sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "reasoning_delta", reasoning: delta.reasoning_content } });
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccum[idx]) {
                      const safeId = normalizeToolCallId(tc.id, "anthropic");
                      // Custom LLMs (Kimi K2.7, Qwen 3.6, Agnes) embed the
                      // tool name in the ID (`functions.<name>:N`) and leave
                      // `function.name` empty on the first delta. Recover it
                      // here so we don't emit a nameless `content_block_start`
                      // to VS — VS can't dispatch a nameless tool and returns
                      // null, polluting the next turn's context.
                      const tcName = tc.function?.name || extractNameFromToolId(tc.id);
                      toolCallAccum[idx] = { id: safeId, name: tcName, args: "" };
                      if (tc.id || tcName) {
                        nextContentIdx++;
                        sseEvent(sock, "content_block_start", { type: "content_block_start", index: nextContentIdx, content_block: { type: "tool_use", id: safeId, name: tcName, input: {} } });
                      }
                    }
                    if (tc.function?.name && !toolCallAccum[idx].name) {
                      toolCallAccum[idx].name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      toolCallAccum[idx].args += tc.function.arguments;
                      sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
                    }
                    streamLog.addToolCall(idx, toolCallAccum[idx].id, tc.function?.name || extractNameFromToolId(tc.id) || toolCallAccum[idx].name, tc.function?.arguments || "");
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
        // then close the stream. Without this, the content sits in greetingBuf
        // and never reaches VS.
        if (!greetingDone && greetingBuf.length > 0) {
          const stripped = stripCopilotGreeting(greetingBuf);
          if (stripped.length > 0) {
            fullContent += stripped;
            sseEvent(sock, "content_block_delta", { type: "content_block_delta", index: nextContentIdx, delta: { type: "text_delta", text: stripped } });
          }
          greetingDone = true;
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
          streamLog.flush({
            repaired: _streamFixed.length,
            dropped: _streamDropped.length,
            apologyInjected: _streamApology && _streamAllDropped,
            loopInjected: _streamLoop.inLoop,
          });
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

        streamLog.flush({
          repaired: _streamFixed.length,
          dropped: _streamDropped.length,
          apologyInjected: _streamApology && _streamAllDropped,
          loopInjected: _streamLoop.inLoop,
        });

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
    const isStream = parsed.stream === true;

    // ── Nag handling for agentic mode (same policy as /v1/messages) ──
    const _respInitiator = headers["x-initiator"] || "";
    const _respInput = Array.isArray(parsed.input) ? parsed.input : [];
    const _lastUser = [..._respInput].reverse().find((m: any) => m.role === "user" || (m.type === "message" && m.role === "user"));
    const _userText = safePreviewFromContent(_lastUser?.content);
    const _isAgentic = _respInitiator === "agent";
    const _nagCount = _isAgentic ? countConsecutiveNags(_respInput) : 0;

    if (_isAgentic && RECENTLY_COMPLETED.get(parsed.model || "") && Date.now() - RECENTLY_COMPLETED.get(parsed.model || "")! < 20000) {
      RECENTLY_COMPLETED.delete(parsed.model || "");
      const emptyResp = buildResponsesFromChatCompletion({ choices: [{ message: { role: "assistant", content: "" } }] }, { model: parsed.model || "unknown" });
      return { handled: true, response: jsonResponse(emptyResp) };
    }
    if (_nagCount > 0) {
      console.log(`[VS NAG] /responses ${parsed.model || ""}: ${_nagCount} consecutive nag(s) → task_complete`);
      RECENTLY_COMPLETED.set(parsed.model || "", Date.now());
      stripNagMessages(_respInput);
      return { handled: true, response: jsonResponse(buildResponsesTaskComplete(parsed.model || "unknown")) };
    }

    let model = parsed.model || "";
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
      const origModel = model;
      if (!model && _lastRealModel) {
        model = _lastRealModel;
      } else {
        const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
        model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      }
      console.log(`[MODEL VS/RESPONSES] ${origModel || "(empty)"} not found, picked ${model}`);
    }
    _lastRealModel = model;

    let startTime = Date.now();
    let responsesComplete: any;
    vsRespLog(`[BEGIN] url=${url} model=${parsed.model || ""} stream=${isStream} x-initiator=${headers["x-initiator"] || ""}`);

    // VS sends empty-body probes ({}) to /responses — no model, no input, no
    // instructions. Short-circuit these before they crash the upstream client.
    if (!parsed.input && !parsed.instructions && !parsed.model && !parsed.previous_response_id) {
      console.log(`[VS RESPONSES] empty probe — returning minimal response`);
      const rr = buildResponsesFromChatCompletion(
        { choices: [{ message: { role: "assistant", content: "" } }] },
        { model: "unknown" }
      );
      return { handled: true, response: jsonResponse(rr) };
    }

    try {
      const identityText = compactIdentity(getModelDisplayName(model), model, parsedTag.thinking || undefined);
      const { messages: flatMessages, system } = flattenResponsesInput(parsed.input);
      vsRespLog(`[FLAT] system=${system ? "yes" : "no"} messages=${JSON.stringify(flatMessages.map((m:any)=>({role:m.role,len:JSON.stringify(m.content||m).length})))}`);
      const messages: any[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "system", content: identityText + (parsed.instructions ? "\n\n" + parsed.instructions : "") });
      for (const m of flatMessages) messages.push(m);

      const scrubbedResp = scrubTaskComplete(messages, parsed.tools || []);
      const cleanMessages = scrubbedResp.messages;
      const cleanTools = scrubbedResp.tools;
      const cleanToolsBn = compressToolDefinitions(cleanTools);

      const vsSession = detectSessionSignal(cleanMessages);
      if (vsSession) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[VS SESSION] ${ts2} [Session#${vsSession.sessNum}>${vsSession.keyLabel}] ${model} "${extractUserPrompt(cleanMessages).substring(0, 120)}"`);
      }

      const vsTag = agentTag(headers);
      const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";

      const lastPreview = [...cleanMessages].reverse().find((m: any) => m.role === "user");
      const messagesPreview = lastPreview ? safePreviewFromContent(lastPreview.content) : "";
      responsesComplete = reqLog({ tag: vsTag, provider: vsProvider, model, preview: messagesPreview, body: parsed });

      const respExtras: Record<string, any> = {};
      if (parsed.reasoning) respExtras.reasoning = parsed.reasoning;
      if (parsed.temperature !== undefined) respExtras.temperature = parsed.temperature;
      if (parsed.top_p !== undefined) respExtras.top_p = parsed.top_p;
      if (parsed.tool_choice !== undefined) respExtras.tool_choice = normalizeToolChoice(parsed.tool_choice);
      if (parsed.parallel_tool_calls !== undefined) respExtras.parallel_tool_calls = parsed.parallel_tool_calls;
      if (parsed.max_output_tokens !== undefined) respExtras.max_output_tokens = parsed.max_output_tokens;
      if (parsed.text !== undefined) respExtras.text = parsed.text;
      if (parsed.store !== undefined) respExtras.store = parsed.store;
      if (parsed.presence_penalty !== undefined) respExtras.presence_penalty = parsed.presence_penalty;
      if (parsed.frequency_penalty !== undefined) respExtras.frequency_penalty = parsed.frequency_penalty;
      if (parsed.stop !== undefined) respExtras.stop = parsed.stop;
      const fallbackRouted = await routeChatWithFallback(model, cleanMessages, cleanToolsBn, isStream, respExtras, vsSession);
      let resp = fallbackRouted.response;
      const rawText = await responseBodyToString(resp);
      const respCt = resp.headers.get("content-type") || "";
      console.log(`[VS RESPONSES] req=${model} resolved=${fallbackRouted.model} status=${resp.status} ct=${respCt} rawLen=${rawText.length}`);
      vsRespLog(`[ROUTE] resolved=${fallbackRouted.model} status=${resp.status} ct=${respCt} rawLen=${rawText.length} rawPreview=${rawText.slice(0, 800).replace(/\n/g, "\\n")}`);

      const respOpts: ResponsesOptions = {
        model: fallbackRouted.model,
        previous_response_id: parsed.previous_response_id,
        instructions: parsed.instructions,
        reasoning: parsed.reasoning,
        tools: cleanToolsBn,
        tool_choice: normalizeToolChoice(parsed.tool_choice),
        temperature: parsed.temperature,
        top_p: parsed.top_p,
        max_output_tokens: parsed.max_output_tokens,
        parallel_tool_calls: parsed.parallel_tool_calls,
        text: parsed.text,
        store: parsed.store,
        // Pass conversation history so the tool salvager's detectToolLoop can
        // walk prior assistant turns on the /responses streaming path.
        messages: cleanMessages,
      };

      const upstreamIsSSE = respCt.includes("event-stream") || rawText.trim().startsWith("data:");

      // Build the final response object first (handles non-JSON, stripping, salvaging, etc.)
      let openaiData: any;
      if (upstreamIsSSE) {
        // Use already parsed streaming logic below; don't pre-build JSON here.
      } else {
        if (resp.status >= 400) {
          console.log(`[VS RESPONSES] upstream error ${resp.status}: ${rawText.slice(0, 500)}`);
          vsRespLog(`[UPSTREAM ERROR] status=${resp.status} body=${rawText.slice(0, 500)}`);
          const errMsg = rawText.length > 500 ? rawText.slice(0, 500) + "..." : rawText;
          openaiData = { choices: [{ message: { role: "assistant", content: `[Error] Upstream returned ${resp.status}: ${errMsg}` } }] };
        } else {
          try { openaiData = JSON.parse(rawText); } catch (e: any) {
            console.log(`[VS RESPONSES] upstream non-JSON (${resp.status}): ${rawText.slice(0, 300)}`);
            openaiData = { choices: [{ message: { role: "assistant", content: `Upstream error (${resp.status}): ${rawText.slice(0, 500)}` } }] };
          }
          if (openaiData?.choices?.[0]?.message?.content) {
            openaiData.choices[0].message.content = stripCopilotGreeting(openaiData.choices[0].message.content);
          }
        }
      }

      // The client requested stream=true, so WE are responsible for streaming back as SSE
      // regardless of whether the upstream returned a JSON blob or proper SSE.
      const sock = req.clientSocket;
      const copilotServiceReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));
      const quotaHeaders = buildQuotaSnapshotHeaders();
      if (isStream && sock) {
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-copilot-service-request-id: ${copilotServiceReqId}\r\n${quotaHeaders}connection: close\r\n\r\n`;
        sock.write(respHead);

        let emittedBytes = 0;
        let firstChunk = "";
        try {
          if (upstreamIsSSE) {
            const reader = new ReadableStream({
              start(controller) {
                const lines = rawText.split("\n");
                for (const line of lines) {
                  controller.enqueue(new TextEncoder().encode(line + "\n"));
                }
                controller.close();
              }
            }).getReader();
            for await (const chunk of streamChatCompletionToResponses(reader, respOpts)) {
              if (sock.destroyed || sock.closed) break;
              emittedBytes += chunk.length;
              if (firstChunk.length < 500) firstChunk += chunk;
              try { sock.write(chunk); } catch { break; }
            }
          } else {
            const rr = buildResponsesFromChatCompletion(openaiData, respOpts);
            vsRespLog(`[RESPONSE JSON] output_items=${rr.output?.length || 0} firstText=${JSON.stringify(rr.output?.[0]?.content?.[0]?.text || "").slice(0, 200)}`);
            try {
              for await (const chunk of streamResponsesObjectToSSE(rr)) {
                if (sock.destroyed || sock.closed) break;
                emittedBytes += chunk.length;
                if (firstChunk.length < 500) firstChunk += chunk;
                try { sock.write(chunk); } catch { break; }
              }
            } catch (sseErr: any) {
              vsRespLog(`[SSE OBJ ERR] ${sseErr.message}`);
            }
            vsRespLog(`[STREAM OBJ DONE] emittedBytes=${emittedBytes} firstChunk=${firstChunk.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        } catch (streamErr: any) {
          vsRespLog(`[STREAM ERR] ${streamErr.message}`);
          console.log(`[VS RESPONSES] stream error: ${streamErr.message}`);
        }
        vsRespLog(`[STREAM DONE] emittedBytes=${emittedBytes} firstChunk=${firstChunk.slice(0, 500).replace(/\n/g, "\\n")}`);
        sock.end();
        const elapsed = Date.now() - startTime;
        if (responsesComplete) responsesComplete(elapsed);
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }

      // No socket fallback: build JSON object only if upstream was also non-streaming
      const elapsed = Date.now() - startTime;
      if (responsesComplete) responsesComplete(elapsed);
      if (!upstreamIsSSE) {
        const rr = buildResponsesFromChatCompletion(openaiData, respOpts);
        const quotaHdrs: Record<string, string> = {};
        const now = new Date();
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const rst = nextMonth.toISOString();
        quotaHdrs["x-quota-snapshot-chat"] = `ent=500&ov=0.0&ovPerm=false&rem=58.0&rst=${rst}&totRem=290.0`;
        quotaHdrs["x-quota-snapshot-completions"] = `ent=4000&ov=0.0&ovPerm=false&rem=58.0&rst=${rst}&totRem=2320.0`;
        quotaHdrs["x-quota-snapshot-premium_interactions"] = `ent=1000&ov=0.0&ovPerm=false&rem=58.0&rst=${rst}&totRem=580.0`;
        quotaHdrs["x-copilot-service-request-id"] = copilotServiceReqId;
        return { handled: true, response: {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-cache",
            "content-security-policy": "default-src 'none'; sandbox",
            "strict-transport-security": "max-age=31536000",
            "access-control-allow-origin": "*",
            ...quotaHdrs,
          },
          body: Buffer.from(JSON.stringify(rr)),
        } };
      }
      return { handled: true, response: jsonResponse({ error: "no socket" }, 500) };
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      if (responsesComplete) responsesComplete(elapsed);
      vsRespLog(`[FATAL] ${e.message}\n${e.stack || ""}`);
      console.log(`[VS RESPONSES] error: ${e.message}`);
      const rr = buildResponsesFromChatCompletion({
        choices: [{ message: { role: "assistant", content: `Mock response (upstream: ${e.message})` } }]
      }, { model: parsed.model || "unknown" });
      // If the client requested streaming, we MUST respond with SSE — returning
      // a plain JSON body here leaves VS in SSE-parsing mode and throws
      // "Can not write new content part while streaming block is open" /
      // NullReferenceException in CopilotClient.ChatCoreWithResponsesAPIAsync.
      // The SSE response headers may not have been written yet (the error can
      // fire before the streaming block at line ~1099), so write them here
      // before streaming the error object.
      const sock = req.clientSocket;
      if (isStream && sock && !sock.destroyed && !sock.closed) {
        const copilotServiceReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));
        const quotaHeaders = buildQuotaSnapshotHeaders();
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-copilot-service-request-id: ${copilotServiceReqId}\r\n${quotaHeaders}connection: close\r\n\r\n`;
        try {
          sock.write(respHead);
          for await (const chunk of streamResponsesObjectToSSE(rr)) {
            if (sock.destroyed || sock.closed) break;
            try { sock.write(chunk); } catch { break; }
          }
        } catch (sseErr: any) {
          vsRespLog(`[FATAL SSE] ${sseErr.message}`);
        }
        try { sock.end(); } catch {}
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      return { handled: true, response: jsonResponse(rr) };
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
    const _chatPrompt = safePreviewFromContent(_chatLastUser?.content).slice(-200);
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
      const origModel = model;
      if (!model && _lastRealModel) {
        model = _lastRealModel;
      } else {
        const real = FAKE_MODELS.find((m: any) => !m.id.includes("-embedding"));
        model = real?.id || (FAKE_MODELS.length > 0 ? FAKE_MODELS[0].id : "big-pickle");
      }
      console.log(`[MODEL VS/CHAT] ${origModel || "(empty)"} not found, picked ${model}`);
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
      const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "unknown";

      const chatExtras: Record<string, any> = { max_tokens: maxTokens };
      if (parsed.reasoning) chatExtras.reasoning = parsed.reasoning;
      if (parsed.temperature !== undefined) chatExtras.temperature = parsed.temperature;
      if (parsed.top_p !== undefined) chatExtras.top_p = parsed.top_p;
      if (parsed.tool_choice !== undefined) chatExtras.tool_choice = normalizeToolChoice(parsed.tool_choice);
      if (parsed.parallel_tool_calls !== undefined) chatExtras.parallel_tool_calls = parsed.parallel_tool_calls;
      if (parsed.max_output_tokens !== undefined) chatExtras.max_output_tokens = parsed.max_output_tokens;
      if (parsed.text !== undefined) chatExtras.text = parsed.text;
      if (parsed.store !== undefined) chatExtras.store = parsed.store;
      if (parsed.presence_penalty !== undefined) chatExtras.presence_penalty = parsed.presence_penalty;
      if (parsed.frequency_penalty !== undefined) chatExtras.frequency_penalty = parsed.frequency_penalty;
      if (parsed.stop !== undefined) chatExtras.stop = parsed.stop;
      const fallbackRouted = await routeChatWithFallback(model, chatMessages, chatToolsBn, isStream, chatExtras, session);
      let resp = fallbackRouted.response;
      if (fallbackRouted.model !== model) {
        console.log(`[VS CHAT] routed ${model} → ${fallbackRouted.model} (fallback)`);
      }
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
        const chatQuotaHdrs = buildQuotaSnapshotHeaders();
        const chatSvcReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-copilot-service-request-id: ${chatSvcReqId}\r\n${chatQuotaHdrs}connection: close\r\n\r\n`;
        sock.write(respHead);
        const streamLog = new StreamResponseLogger({ endpoint: "/chat/completions", model, resolved: fallbackRouted.model, status: resp.status });
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let sseLen = 0;
        let passthroughBuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          sock.write(chunk);
          sseLen += chunk.length;
          passthroughBuf += chunk;
          const lines = passthroughBuf.split("\n");
          passthroughBuf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              try {
                const d = JSON.parse(t.slice(6));
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) streamLog.addContent(delta.content);
                if (delta?.reasoning_content) streamLog.addReasoning(delta.reasoning_content);
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
        sock.end();
        recordTps(sseLen, Date.now() - vsReqStart);
        if (vsChatComplete) vsChatComplete(Date.now() - vsReqStart);
        streamLog.flush();
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
          const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`;
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

  // POST /models/session or /v1/models/session — VS 2022 (17.x) auto model resolution
  // VS 2022 calls GetNewAutoModelAsync which POSTs to /models/session to get a
  // "model session token" before sending the actual chat request. Real GitHub
  // may not support this older flow → return a fake session with the legacy model.
  if (method === "POST" && (url === "/models/session" || url === "/v1/models/session" || url.startsWith("/models/session?") || url.startsWith("/v1/models/session?"))) {
    const legacyModel = getVsLegacyModel() || "umans-kimi-k2.7";
    const now = Math.floor(Date.now() / 1000);
    const sessionId = `sess-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
    const tokenPayload = JSON.stringify({ sub: forge.util.bytesToHex(forge.random.getBytesSync(20)), iat: now, exp: now + 3600 });
    const sessionToken = `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(tokenPayload).toString("base64url")}.${forge.util.bytesToHex(forge.random.getBytesSync(32))}`;
    return { handled: true, response: jsonResponse({
      available_models: [legacyModel],
      selected_model: legacyModel,
      session_token: sessionToken,
      session_id: sessionId,
      id: sessionId,
      expires_at: now + 3600,
    }) };
  }

  // GET /embeddings/models — embedding model list (VS 2022 queries this)
  if (method === "GET" && (url === "/embeddings/models" || url.startsWith("/embeddings/models?"))) {
    return { handled: true, response: jsonResponse({ data: [] }) };
  }

  // POST /v1/embeddings or /embeddings — VS 2022 builds embedding vectors for
  // suggested actions. Must return one vector per input element.
  if (method === "POST" && (url.includes("/embeddings") || url.includes("/v1/embeddings"))) {
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
    return { handled: true, response: jsonResponse({
      object: "list",
      data,
      model: "text-embedding-3-small",
      usage: { prompt_tokens: inputCount * 2, total_tokens: inputCount * 2 },
    }) };
  }

  // Never swallow OAuth/auth routes with the catch-all mock — returning
  // {"ok":true,"message":"VS mock response"} (no access_token) breaks the
  // GitHub account sign-in flow (VS error 723: "authorization token is null
  // after OAuth client request"). Let handleAuth handle them.
  const isAuthRoute = url.includes("/login/oauth/") || url.includes("/login/device") || url === "/login" || url.startsWith("/login?");
  if (isAuthRoute) {
    return { handled: false };
  }

  // Catch-all for any other VS endpoint — return mock rather than falling through to upstream
  if (isVisualStudio) {
    return { handled: true, response: jsonResponse({ ok: true, message: "VS mock response" }) };
  }

  return { handled: false };
}

