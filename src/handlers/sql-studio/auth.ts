// VS Team Explorer / SSMS chat delegation.
//
// Auth (copilot_internal/user, /v2/token, content_exclusion, OAuth
// passthrough) is now handled by the unified handleVSShell in
// handlers/vs-shell/auth.ts — VS Team Explorer shares the exact same
// OAuth flow and copilot_internal responses as VS Copilot Client, so a
// single auth handler covers both.
//
// SSMS (SQL Server Management Studio) ships as a VS-shell client with
// editor-version `VS/SSMS.22.SSMS.Release/...` and UA `VSCopilotClient/...`.
// Unlike real Visual Studio, SSMS only ever hits `/chat/completions` and
// expects the Copilot SSE format (prompt_filter_results +
// content_filter_results wrappers, the client's model name echoed back,
// x-quota-snapshot-* headers, copilot-edits-session). The VS handler's
// /chat/completions path does raw OpenAI passthrough which lacks all of
// this, so SSMS chat breaks. We handle /chat/completions here with a
// dedicated Copilot-format streamer and delegate everything else to the
// VS handler.

import forge from "node-forge";
import { HandlerInput, HandlerResult, jsonResponse, scrubTaskComplete, compressToolDefinitions, injectIdentity, stripCopilotGreeting, RECENT_BODIES, safePreviewFromContent } from "../../shared.ts";
import { trackRequest } from "../../usage-tracker.ts";
import { handleVSModels } from "../vs/models.ts";
import { handleVisualStudio } from "../vs/handler.ts";
import { chatCompletion as openAIChat, getModelDisplayName, getModelProviderTag, detectSessionSignal, extractUserPrompt } from "../openai-provider.ts";
import { chatCompletion as freebuffChat } from "../freebuff-client.ts";
import { chatCompletion as agnesChat } from "../agnes-client.ts";
import { chatCompletion as codestralChat } from "../codestral-client.ts";
import { chatCompletion as bitnetChat } from "../bitnet-client.ts";
import { chatCompletion as umansChat } from "../umans-client.ts";
import { StreamResponseLogger } from "../../streaming-log.ts";
import { repairToolCalls, detectApologyText, detectToolLoop, buildOpenAITaskComplete, bumpSalvageStat, extractNameFromToolId } from "../../tool-salvager.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";

export function isSQLStudio(headers: Record<string, string>): boolean {
  const ua = (headers?.["user-agent"] || "").toLowerCase();
  if (ua.includes("vsteamexplorer")) return true;
  const ev = headers?.["editor-version"] || "";
  if (ev.startsWith("VS/SSMS")) return true;
  const interactionType = headers?.["x-interaction-type"] || "";
  if (interactionType.includes("SSMSAgent")) return true;
  return false;
}

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

// Copilot content-filter wrapper — real GitHub includes this on every chunk.
const SAFE_FILTER = { hate: { filtered: false, severity: "safe" }, self_harm: { filtered: false, severity: "safe" }, sexual: { filtered: false, severity: "safe" }, violence: { filtered: false, severity: "safe" } };

function buildQuotaSnapshotHeaders(): string {
  const rst = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString();
  return [
    `x-quota-snapshot-chat: ent=200&ov=0.0&ovPerm=false&rem=96.0&rst=${rst}&totRem=192.0\r\n`,
    `x-quota-snapshot-completions: ent=2000&ov=0.0&ovPerm=false&rem=99.9&rst=${rst}&totRem=1998.0\r\n`,
    `x-quota-snapshot-premium_interactions: ent=0&ov=0.0&ovPerm=false&rem=0.0&rst=${rst}&totRem=0.0\r\n`,
  ].join("");
}

// Parse a thinking-mode tag out of a VS model display name (e.g. "DeepSeek V4 [HI]").
function parseThinkingMode(modelName: string): { model: string; thinking: string | null } {
  const m = modelName.match(/^(.*?)\s*\[(LO|MD|HI|MX)\]$/i);
  if (m) return { model: m[1].trim(), thinking: m[2].toUpperCase() };
  const suffix = modelName.match(/^(.+?)-(lo|md|hi|mx)$/i);
  if (suffix) return { model: suffix[1].trim(), thinking: suffix[2].toUpperCase() };
  return { model: modelName, thinking: null };
}

/**
 * Handle SSMS /chat/completions with the Copilot SSE format (prompt_filter_results +
 * content_filter_results wrappers, client's model name echoed back, Copilot headers).
 * Falls back to the VS handler for non-chat routes.
 */
async function handleSSMSChatCompletions(req: HandlerInput): Promise<HandlerResult> {
  const { headers, method, url, body } = req;
  const reqStart = Date.now();

  let parsed: any = {};
  try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}

  const requestedModel = parsed.model || "gpt-5-mini";
  const messages = parsed.messages || [];
  const tools = parsed.tools || [];
  const isStream = parsed.stream === true;
  const maxTokens = parsed.max_tokens || 4096;

  // Dedup: identical model+prompt within 5s → empty stop
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  const promptPreview = safePreviewFromContent(lastUser?.content).slice(-200);
  const dedupKey = `${requestedModel}:${promptPreview}`;
  if (promptPreview && (RECENT_BODIES.get(dedupKey) ?? 0) && Date.now() - (RECENT_BODIES.get(dedupKey) ?? 0) < 5000) {
    const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
    const created = Math.floor(Date.now() / 1000);
    const sse = `data: ${JSON.stringify({ choices: [], created: 0, id: "", model: requestedModel, prompt_filter_results: [{ content_filter_results: SAFE_FILTER, prompt_index: 0 }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, content_filter_results: {}, delta: { role: "assistant", content: "" } }], created, id, model: requestedModel })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, content_filter_results: {}, delta: {}, finish_reason: "stop" }], created, id, model: requestedModel })}\n\ndata: [DONE]\n\n`;
    return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "close" }, body: Buffer.from(sse) } };
  }
  if (promptPreview) RECENT_BODIES.set(dedupKey, Date.now());

  // Resolve model to a real upstream model
  const parsedTag = parseThinkingMode(requestedModel);
  let model = parsedTag.model;
  // Category-separator models → first real model
  if (model.startsWith("_sep_") || model.startsWith("cat_") || model.startsWith("_cat_")) {
    model = "deepseek-v4-flash";
  }
  // Common VS/Copilot model aliases → real model
  const aliases: Record<string, string> = {
    "gpt-4o": "", "gpt-4": "", "gpt-3.5-turbo": "", "gpt-4-turbo": "",
    "gpt-5-mini": "", "gpt-4.1": "", "gpt-5": "", "claude-haiku-4.5": "",
  };
  if (aliases[model] !== undefined) {
    model = "deepseek-v4-flash";
  }
  // If still not in our model list and not provider-routed, pick a default
  if (!isProviderRouted(model) && !model.startsWith("deepseek") && !model.startsWith("mimo") && !model.startsWith("minimax") && !model.startsWith("kimi")) {
    model = "deepseek-v4-flash";
  }

  if (!messages.length) messages.push({ role: "user", content: "Hello" });

  // Sanitize tools
  const cleanTools = (tools || []).filter((t: any) => {
    const fn = t.function || t;
    return fn.name && fn.name.length > 0;
  });

  injectIdentity(messages, getModelDisplayName(model), model, parsedTag.thinking || undefined);

  const scrubbed = scrubTaskComplete(messages, cleanTools);
  const chatMessages = scrubbed.messages;
  const chatTools = scrubbed.tools;
  const chatToolsBn = compressToolDefinitions(chatTools);

  const session = detectSessionSignal(chatMessages);
  const vsTag = agentTag(headers);
  const vsProvider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral") ? "codestral" : (model === "bitnet-demo" || model.startsWith("bitnet/")) ? "bitnet" : "go";
  const completeLog = reqLog({ tag: vsTag, provider: vsProvider, model, preview: extractUserPrompt(chatMessages), body: parsed });

  // Build extras
  const extras: Record<string, any> = { max_tokens: maxTokens };
  if (parsed.temperature !== undefined) extras.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) extras.top_p = parsed.top_p;
  if (parsed.tool_choice !== undefined) extras.tool_choice = parsed.tool_choice;
  if (parsed.parallel_tool_calls !== undefined) extras.parallel_tool_calls = parsed.parallel_tool_calls;
  if (parsed.reasoning !== undefined) extras.reasoning = parsed.reasoning;
  if (parsed.presence_penalty !== undefined) extras.presence_penalty = parsed.presence_penalty;
  if (parsed.frequency_penalty !== undefined) extras.frequency_penalty = parsed.frequency_penalty;
  if (parsed.stop !== undefined) extras.stop = parsed.stop;

  try {
    const resp = await routeChat(model, chatMessages, chatToolsBn, isStream, extras, session);
    const chatcmplId = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(12))}`;
    const copilotEditsSession = `${Math.floor(Date.now() / 1000)}.${forge.util.bytesToHex(forge.random.getBytesSync(32))}`;
    const svcReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));

    // ── Non-streaming: wrap upstream response into Copilot Chat Completions JSON ──
    if (!isStream) {
      const data: any = await resp.json();
      if (data?.choices?.[0]?.message?.content) {
        data.choices[0].message.content = stripCopilotGreeting(data.choices[0].message.content);
      }
      recordTps(data.usage?.completion_tokens || (data.choices?.[0]?.message?.content || "").length, Date.now() - reqStart);
      if (completeLog) completeLog(Date.now() - reqStart);

      // Tool salvager
      let msg = data.choices?.[0]?.message || {};
      if (msg.tool_calls?.length) {
        const { repaired, dropped } = repairToolCalls(msg.tool_calls);
        const allDropped = msg.tool_calls.length > 0 && repaired.length === 0;
        const isApology = detectApologyText(msg.content || "");
        const isLoop = repaired.length ? detectToolLoop(chatMessages, { name: repaired[0].function?.name || "", arguments: repaired[0].function?.arguments || "{}" }) : { inLoop: false, count: 0, tool: "", args: "" };
        if ((isApology && allDropped) || isLoop.inLoop) {
          bumpSalvageStat(isLoop.inLoop ? "loopInjected" : "apologyInjected");
          msg = { role: "assistant", content: "", tool_calls: [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }] };
          data.choices = [{ index: 0, message: msg, finish_reason: "tool_calls" }];
        } else {
          msg.tool_calls = repaired;
        }
      } else if (detectApologyText(msg.content || "")) {
        bumpSalvageStat("apologyInjected");
        msg = { role: "assistant", content: "", tool_calls: [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }] };
        data.choices = [{ index: 0, message: msg, finish_reason: "tool_calls" }];
      }

      // Wrap into Copilot non-stream format
      const out: any = {
        id: chatcmplId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: (data.choices || []).map((c: any) => ({
          index: c.index ?? 0,
          message: c.message || { role: "assistant", content: "" },
          finish_reason: c.finish_reason || "stop",
          content_filter_results: SAFE_FILTER,
        })),
        usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        prompt_filter_results: [{ content_filter_results: SAFE_FILTER, prompt_index: 0 }],
      };
      return { handled: true, response: jsonResponse(out) };
    }

    // ── Streaming: wrap upstream OpenAI SSE into Copilot SSE format ──
    const sock = req.clientSocket;
    const ct = resp.headers.get("content-type") || "";
    const actualStream = ct.includes("text/event-stream");

    // Header preamble matching real Copilot
    const respHead =
      `HTTP/1.1 200 OK\r\n` +
      `content-type: text/event-stream\r\n` +
      `cache-control: no-cache\r\n` +
      `content-security-policy: default-src 'none'; sandbox\r\n` +
      `strict-transport-security: max-age=31536000\r\n` +
      `access-control-allow-origin: *\r\n` +
      `x-accel-buffering: no\r\n` +
      `x-copilot-service-request-id: ${svcReqId}\r\n` +
      `copilot-edits-session: ${copilotEditsSession}\r\n` +
      `x-copilot-api-exp-assignment-context: 5133j383:1109202;c_a15ch289:1165001;\r\n` +
      `x-github-backend: Kubernetes\r\n` +
      `x-github-request-id: D048:330F51:${forge.util.bytesToHex(forge.random.getBytesSync(3)).toUpperCase()}:${forge.util.bytesToHex(forge.random.getBytesSync(3)).toUpperCase()}:${forge.util.bytesToHex(forge.random.getBytesSync(4)).toUpperCase()}\r\n` +
      buildQuotaSnapshotHeaders() +
      `connection: close\r\n\r\n`;

    // Helper: write a Copilot-format SSE data line
    const writeCopilotSse = (payload: any) => {
      if (!sock || sock.destroyed || sock.closed) return;
      sock.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // First chunk: prompt_filter_results (empty choices, client's model name)
    const promptFilterChunk = { choices: [], created: 0, id: "", model: requestedModel, prompt_filter_results: [{ content_filter_results: SAFE_FILTER, prompt_index: 0 }] };

    if (sock) {
      sock.write(respHead);
      writeCopilotSse(promptFilterChunk);
    }

    if (!actualStream) {
      // Upstream returned JSON, not SSE — synthesize a Copilot stream
      const data: any = await resp.json().catch(() => ({}));
      const msg = data.choices?.[0]?.message || {};
      const content = stripCopilotGreeting(msg.content || "") || "";
      const toolCalls = msg.tool_calls || [];
      const finishReason = toolCalls.length ? "tool_calls" : (data.choices?.[0]?.finish_reason || "stop");
      const created = Math.floor(Date.now() / 1000);

      // Tool salvager on non-streaming-as-stream
      let finalToolCalls = toolCalls;
      let finalContent = content;
      if (finalToolCalls.length) {
        const { repaired, dropped } = repairToolCalls(finalToolCalls);
        const allDropped = finalToolCalls.length > 0 && repaired.length === 0;
        const isApology = detectApologyText(content);
        const isLoop = repaired.length ? detectToolLoop(chatMessages, { name: repaired[0].function?.name || "", arguments: repaired[0].function?.arguments || "{}" }) : { inLoop: false, count: 0, tool: "", args: "" };
        if ((isApology && allDropped) || isLoop.inLoop) {
          bumpSalvageStat(isLoop.inLoop ? "loopInjected" : "apologyInjected");
          finalToolCalls = [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }];
          finalContent = "";
        } else {
          finalToolCalls = repaired;
        }
      } else if (detectApologyText(content)) {
        bumpSalvageStat("apologyInjected");
        finalToolCalls = [{ id: `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: { name: "task_complete", arguments: "{}" } }];
        finalContent = "";
      }

      // Role/content delta
      writeCopilotSse({ choices: [{ index: 0, content_filter_results: {}, delta: { role: "assistant", content: finalContent ? "" : null, ...(finalToolCalls.length ? { tool_calls: finalToolCalls.map((tc: any, i: number) => ({ index: i, id: tc.id || `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`, type: "function", function: tc.function || { name: tc.name || "unknown", arguments: tc.arguments || "{}" } })) } : {}) } }], created, id: chatcmplId, model: requestedModel });
      // Stream content in chunks if present
      if (finalContent) {
        const chunks = finalContent.match(/.{1,64}/g) || [finalContent];
        for (const chunk of chunks) {
          writeCopilotSse({ choices: [{ index: 0, content_filter_results: SAFE_FILTER, delta: { content: chunk } }], created, id: chatcmplId, model: requestedModel });
        }
      }
      // Finish
      writeCopilotSse({ choices: [{ index: 0, content_filter_results: SAFE_FILTER, delta: {}, finish_reason: finalToolCalls.length ? "tool_calls" : finishReason }], created, id: chatcmplId, model: requestedModel });
      writeCopilotSse({ choices: [{ index: 0, content_filter_results: SAFE_FILTER, delta: {}, finish_reason: finalToolCalls.length ? "tool_calls" : finishReason }], created, id: chatcmplId, model: requestedModel, usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      sock?.write("data: [DONE]\n\n");
      sock?.end();
      recordTps(finalContent.length, Date.now() - reqStart);
      if (completeLog) completeLog(Date.now() - reqStart);
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    }

    // Streaming upstream: parse OpenAI SSE and re-emit as Copilot SSE
    const streamLog = new StreamResponseLogger({ endpoint: "/chat/completions", model, resolved: model, status: resp.status });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sseLen = 0;
    const created = Math.floor(Date.now() / 1000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;
      sseLen += chunk.length;
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
        try {
          const d = JSON.parse(t.slice(6));
          const choice = d.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          // Rewrite model to the client's requested model, attach content_filter_results
          const outChoice: any = { index: 0, content_filter_results: delta.content ? SAFE_FILTER : {}, delta: {} };
          if (delta.role) outChoice.delta.role = delta.role;
          if (delta.content !== undefined && delta.content !== null) outChoice.delta.content = delta.content;
          if (delta.reasoning_content) outChoice.delta.reasoning_content = delta.reasoning_content;
          if (delta.tool_calls) {
            outChoice.delta.tool_calls = delta.tool_calls.map((tc: any) => ({
              index: tc.index ?? 0,
              id: tc.id || `call_${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
              type: "function",
              function: { name: tc.function?.name || extractNameFromToolId(tc.id) || "unknown", arguments: tc.function?.arguments || "" },
            }));
          }
          if (choice.finish_reason) {
            outChoice.finish_reason = choice.finish_reason;
            outChoice.delta = {};
          }
          if (d.usage) {
            outChoice.usage = d.usage;
          }
          streamLog.addContent(delta.content || "");
          if (delta.reasoning_content) streamLog.addReasoning(delta.reasoning_content);
          if (delta.tool_calls) for (const tc of delta.tool_calls) streamLog.addToolCall(tc.index ?? 0, tc.id || "", tc.function?.name || extractNameFromToolId(tc.id) || "", tc.function?.arguments || "");
          if (choice.finish_reason) streamLog.setFinishReason(choice.finish_reason);
          if (d.usage) streamLog.setUsage(d.usage);
          writeCopilotSse({ choices: [outChoice], created, id: chatcmplId, model: requestedModel, ...(d.usage ? { usage: d.usage } : {}) });
        } catch {}
      }
    }
    sock?.write("data: [DONE]\n\n");
    sock?.end();
    recordTps(sseLen, Date.now() - reqStart);
    if (completeLog) completeLog(Date.now() - reqStart);
    streamLog.flush();
    return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
  } catch (e: any) {
    if (completeLog) completeLog(Date.now() - reqStart);
    console.log(`[SSMS CHAT FALLBACK] ${e.message} — using local mock`);
    const mockContent = "I'm ready to help with your SQL Server task. What would you like me to work on?";
    const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
    const created = Math.floor(Date.now() / 1000);
    const sse =
      `data: ${JSON.stringify({ choices: [], created: 0, id: "", model: requestedModel, prompt_filter_results: [{ content_filter_results: SAFE_FILTER, prompt_index: 0 }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, content_filter_results: {}, delta: { role: "assistant", content: "" } }], created, id, model: requestedModel })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, content_filter_results: SAFE_FILTER, delta: { content: mockContent } }], created, id, model: requestedModel })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, content_filter_results: SAFE_FILTER, delta: {}, finish_reason: "stop" }], created, id, model: requestedModel })}\n\n` +
      `data: [DONE]\n\n`;
    const sock = req.clientSocket;
    if (sock && isStream) {
      const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`;
      sock.write(respHead);
      sock.write(sse);
      sock.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    }
    return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "close" }, body: Buffer.from(sse) } };
  }
}

/**
 * Delegate VS Team Explorer / SSMS requests. Auth routes are handled
 * upstream by handleVSShell, so this only touches chat endpoints.
 * SSMS /chat/completions is handled locally with the Copilot SSE format;
 * other chat routes (/v1/messages, /responses) spoof editor-version and
 * delegate to handleVisualStudio.
 */
export async function handleSQLStudioChat(req: HandlerInput): Promise<HandlerResult> {
  const { headers, method, url } = req;
  if (!isSQLStudio(headers)) return { handled: false };

  // VS model list — handled here so the spoofed editor-version is in effect
  const vsModelsResult = await handleVSModels(req);
  if (vsModelsResult.handled) return vsModelsResult;

  // SSMS /chat/completions — Copilot SSE format (dedicated handler)
  if (method === "POST" && (url === "/chat/completions" || url.startsWith("/chat/completions"))) {
    trackRequest("vs");
    console.log(`[SSMS] Handling /chat/completions locally (Copilot SSE format)`);
    return handleSSMSChatCompletions(req);
  }

  // Other chat routes — spoof editor-version and delegate to VS handler
  const isChatRoute =
    method === "POST" &&
    (url === "/v1/messages" ||
      url.startsWith("/v1/messages") ||
      url === "/responses" ||
      url.startsWith("/responses"));
  if (!isChatRoute) return { handled: false };

  trackRequest("vs");
  const origEditorVersion = headers["editor-version"] || "";
  if (!origEditorVersion.startsWith("VS/VisualStudio")) {
    headers["editor-version"] = "VS/VisualStudio.17.SQLStudio";
  }
  console.log(`[SQL STUDIO] Delegating ${req.method} ${req.url} to VS handler`);
  const vsResult = await handleVisualStudio(req);
  if (vsResult.handled) return vsResult;
  if (!origEditorVersion.startsWith("VS/VisualStudio")) {
    headers["editor-version"] = origEditorVersion;
  }
  return { handled: false };
}
