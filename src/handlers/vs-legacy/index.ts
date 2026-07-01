import forge from "node-forge";
import { jsonResponse, ghApiJsonResponse, HandlerInput, HandlerResult, getGithubSku, getGithubUsername, getGithubDisplayName, injectIdentity, compactIdentity, scrubTaskComplete, compressToolDefinitions, stripCopilotGreeting, getProjectRoot, normalizeToolCallId, safePreviewFromContent } from "../../shared.ts";
import { chatCompletion as umansChat } from "../umans-client.ts";
import { chatCompletion as freebuffChat } from "../freebuff-client.ts";
import { chatCompletion as agnesChat } from "../agnes-client.ts";
import { chatCompletion as codestralChat } from "../codestral-client.ts";
import { chatCompletion as bitnetChat } from "../bitnet-client.ts";
import { chatCompletion as openAIChat, getModelDisplayName, getModelProviderTag, detectSessionSignal, extractUserPrompt } from "../openai-provider.ts";
import { addModels } from "../../models.ts";
import { filterModelsByConfig } from "../../shared.ts";
import { getVsLegacyModel } from "../dashboard-handler.ts";
import { recordTps, reqLog, agentTag } from "../../split-console.ts";
import { trackRequest } from "../../usage-tracker.ts";
import { handleVSModels, ensureVSModels, VS_MODELS } from "../vs/models.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { buildResponsesFromChatCompletion, streamChatCompletionToResponses, streamResponsesObjectToSSE, flattenResponsesInput, ResponsesOptions } from "../vs/response-converter.ts";

const VS_RESP_LOG_PATH = join(process.env.LOG_DIR || join(getProjectRoot(), ".proxy-logs"), "vs-responses.log");
function vsRespLog(line: string) {
  try { appendFileSync(VS_RESP_LOG_PATH, `${new Date().toISOString()} ${line}\n`); } catch {}
}

function isVSLegacy(headers: Record<string, string>): boolean {
  const ev = headers["editor-version"] || "";
  const ua = (headers["user-agent"] || "").toLowerCase();
  // VS 2022 (17.x) and older: editor-version VS/17.x or VS/VisualStudio.17.x
  const m = ev.match(/VS\/(?:VisualStudio\.)?(\d+)/);
  if (m) return parseInt(m[1]) < 18;
  // VS Team Explorer with version 17.x
  if (ua.includes("vsteamexplorer")) {
    const vm = ua.match(/vsteamexplorer[^\/]*\/(\d+)/);
    if (vm) return parseInt(vm[1]) < 18;
    return true; // assume legacy if no version
  }
  return false;
}

function getSku() {
  const s = getGithubSku();
  switch (s) {
    case "free":
    case "free_limited_copilot":
      return { copilot_plan: "individual", access_type_sku: "free_limited_copilot", sku: "free_limited_copilot" };
    case "pro":
    case "copilot_for_individual":
      return { copilot_plan: "individual", access_type_sku: "copilot_for_individual", sku: "copilot_for_individual" };
    case "business":
    case "copilot_for_business_seat":
      return { copilot_plan: "business", access_type_sku: "copilot_for_business_seat", sku: "business" };
    case "max":
      return { copilot_plan: "max", access_type_sku: "max", sku: "max" };
    default:
      return { copilot_plan: "enterprise", access_type_sku: "copilot_enterprise_seat", sku: "enterprise" };
  }
}

function getQuota() {
  // VS22 displays remaining as consumed → 42% remaining shows as "42% consumed"
  return { chat: 210, completions: 1680 };
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

function routeChat(model: string, messages: any[], tools: any[] | undefined, stream: boolean, extra: Record<string, any>): Promise<Response> {
  if (model.startsWith("freebuff/")) return freebuffChat(model, messages, tools, stream, extra);
  if (model.startsWith("agnes")) return agnesChat(model, messages, tools, stream, { ...extra });
  if (model.startsWith("codestral/") || model.startsWith("mistral-")) return codestralChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, temperature: extra.temperature, top_p: extra.top_p });
  if (model === "bitnet-demo" || model.startsWith("bitnet/")) return bitnetChat(model, messages, tools, stream, { max_tokens: extra.max_tokens, ...extra });
  if (model.startsWith("umans-") || getModelProviderTag(model) === "umans") return umansChat(model, messages, tools, stream, { ...extra });
  return openAIChat(model, messages, tools, stream, extra);
}

async function resolveModel(model: string): Promise<string> {
  const legacy = getVsLegacyModel();
  if (legacy) return legacy;
  if (isProviderRouted(model)) return model;
  try {
    let ids = await addModels();
    ids = filterModelsByConfig(ids);
    const chatIds = ids.filter((id: string) => { const l = id.toLowerCase(); return !l.includes("embedding") && !l.includes("ada"); });
    for (const tag of ["umans", "agnes", "codestral", "freebuff"]) {
      const pick = chatIds.find((id: string) => getModelProviderTag(id) === tag);
      if (pick) return pick;
    }
    return chatIds[0] || "umans-kimi-k2.7";
  } catch { return "umans-kimi-k2.7"; }
}

export function isVSLegacyClient(headers: Record<string, string>): boolean {
  return isVSLegacy(headers);
}

// Check if this is a VS OAuth browser request (client_id in URL)
const VS_CLIENT_ID = "a200baed193bb2088a6e";
function isVSOAuthBrowser(req: HandlerInput): boolean {
  const { method, url } = req;
  if (url.includes("client_id=" + VS_CLIENT_ID)) return true;
  if (url.includes("client_id=a200baed193bb2088a6e")) return true;
  return false;
}

export async function handleVSLegacy(req: HandlerInput): Promise<HandlerResult> {
  const { method, url, body, headers } = req;

  // Detect VS 2022 (17.x) — by editor-version or user-agent
  if (!isVSLegacy(headers) && !isVSOAuthBrowser(req)) return { handled: false };

  const ev = headers["editor-version"] || "";
  const ua = headers["user-agent"] || "";
  console.log(`[VS LEGACY] ${method} ${url} (editor: ${ev}, ua: ${ua.slice(0, 50)})`);

  const { copilot_plan, access_type_sku, sku } = getSku();
  const isEnterprise = copilot_plan !== "individual";
  const q = getQuota();
  const now = Math.floor(Date.now() / 1000);
  const tid = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const exp = now + 1800;
  // 1st of next month (real GitHub uses this as the quota reset date)
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  const resetTs = Math.floor(nextMonth.getTime() / 1000);
  const resetDateStr = nextMonth.toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  // Monthly quotas: free=200/2000, enterprise=500/4000
  const monthlyChat = isEnterprise ? 500 : 200;
  const monthlyComp = isEnterprise ? 4000 : 2000;
  const chatPct = Math.round((q.chat / monthlyChat) * 100);
  const compPct = Math.round((q.completions / monthlyComp) * 100);

  // ── AUTH: /copilot_internal/user ──
  if (method === "GET" && url.includes("/copilot_internal/user")) {
    trackRequest("vs");
    const ghUser = getGithubUsername();
    const canUpgrade = access_type_sku === "free_limited_copilot" || access_type_sku === "copilot_for_individual";
    return { handled: true, response: ghApiJsonResponse({
      login: ghUser,
      access_type_sku,
      analytics_tracking_id: tid,
      assigned_date: new Date(Date.now() - 12 * 86400000).toISOString(),
      can_signup_for_limited: canUpgrade,
      can_upgrade_plan: canUpgrade,
      chat_enabled: true,
      cli_enabled: true,
      cli_remote_control_enabled: true,
      copilotignore_enabled: isEnterprise,
      copilot_plan,
      editor_preview_features_enabled: true,
      is_mcp_enabled: true,
      is_staff: false,
      organization_login_list: [],
      organization_list: [],
      restricted_telemetry: false,
      cloud_session_storage_enabled: true,
      endpoints: {
        api: "https://api.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
      },
      quota_snapshots: {
        chat: {
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: chatPct,
          quota_id: "chat",
          quota_remaining: q.chat,
          unlimited: isEnterprise,
          timestamp_utc: nowIso,
          has_unlimited_access: isEnterprise,
        },
        completions: {
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: compPct,
          quota_id: "completions",
          quota_remaining: q.completions,
          unlimited: isEnterprise,
          timestamp_utc: nowIso,
          has_unlimited_access: isEnterprise,
        },
        premium_interactions: {
          overage_count: 0,
          overage_permitted: true,
          percent_remaining: 58,
          quota_id: "premium_interactions",
          quota_remaining: 580,
          unlimited: false,
          timestamp_utc: nowIso,
          has_unlimited_access: false,
        },
      },
    }) };
  }

  // ── AUTH: /copilot_internal/v2/token ──
  if (method === "GET" && url.startsWith("/copilot_internal/v2/token")) {
    trackRequest("vs");
    const token = `tid=${tid};exp=${exp};iat=${now};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=0;rt=1;ip=0.0.0.0;asn=AS000000;cq=3934;rd=${resetTs}`;
    return { handled: true, response: ghApiJsonResponse({
      agent_mode_auto_approval: true,
      annotations_enabled: true,
      azure_only: false,
      blackbird_clientside_indexing: false,
      blackbird_external_indexing: true,
      chat_enabled: true,
      chat_jetbrains_enabled: true,
      code_quote_enabled: true,
      code_review_enabled: isEnterprise,
      codesearch: true,
      copilotignore_enabled: isEnterprise,
      endpoints: {
        api: "https://api.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
      },
      expires_at: exp,
      iat: now,
      individual: true,
      limited_user_quotas: { chat: q.chat, completions: q.completions },
      limited_user_reset_date: resetTs,
      public_suggestions: "disabled",
      refresh_in: 1500,
      sku,
      telemetry: "disabled",
      token,
      tracking_id: tid,
    }, 200, { "x-accepted-oauth-scopes": "repo" }) };
  }

  // ── AUTH: /copilot_internal/content_exclusion ──
  if (method === "GET" && url.includes("/copilot_internal/content_exclusion")) {
    return { handled: true, response: jsonResponse({ message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }, 404) };
  }

  // ── MODELS: GET /models ──
  if (method === "GET" && (url === "/models" || url.startsWith("/models?") || url === "/v1/models" || url.startsWith("/v1/models?"))) {
    trackRequest("vs");
    try {
      const vsModelsResult = await handleVSModels(req);
      if (vsModelsResult.handled) return vsModelsResult;
    } catch (e: any) {
      console.log(`[VS LEGACY] handleVSModels failed: ${e.message}, building inline`);
    }
    // Fallback: ensure models loaded and return directly
    try { await ensureVSModels(); } catch (e: any) { console.log(`[VS LEGACY] ensureVSModels failed: ${e.message}`); }
    if (VS_MODELS.length === 0) {
      console.log("[VS LEGACY] VS_MODELS empty — building minimal fallback model");
      const fallbackModels: any[] = [{
        id: "agnes-2.0-flash", object: "model", name: "✨￤Agnes 2.0 Flash",
        vendor: "AgnesAI", version: "agnes-2.0-flash", preview: false,
        model_picker_category: "lightweight", model_picker_enabled: true,
        is_chat_default: true, is_chat_fallback: true,
        billing: { is_premium: false, multiplier: 1, restricted_to: [] },
        policy: { state: "enabled", terms: "" },
        supported_endpoints: ["/chat/completions", "/responses"],
        capabilities: { family: "agnes", object: "model_capabilities", type: "chat", tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 128000, max_output_tokens: 32000, max_prompt_tokens: 64000, max_non_streaming_output_tokens: 16000 },
          supports: { streaming: true, tool_calls: true, parallel_tool_calls: true, vision: false, structured_outputs: true } },
      }];
      const data = { data: fallbackModels, object: "list" };
      console.log(`[VS LEGACY] /models fallback response: ${data.data.length} models`);
      return { handled: true, response: jsonResponse(data) };
    }
    const data = { data: VS_MODELS, object: "list" };
    console.log(`[VS LEGACY] /models response: ${data.data.length} models`);
    return { handled: true, response: jsonResponse(data) };
  }

  // ── MODELS: POST /models/session ──
  if (method === "POST" && (url === "/models/session" || url === "/v1/models/session" || url.startsWith("/models/session?") || url.startsWith("/v1/models/session?"))) {
    const legacyModel = getVsLegacyModel() || "umans-kimi-k2.7";
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

  // ── EMBEDDINGS: GET /embeddings/models ──
  if (method === "GET" && (url === "/embeddings/models" || url.startsWith("/embeddings/models?"))) {
    return { handled: true, response: jsonResponse({ data: [] }) };
  }

  // ── EMBEDDINGS: POST /embeddings ──
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

  // ── AGENTS ──
  if (method === "GET" && (url === "/agents" || url.startsWith("/agents?"))) {
    return { handled: true, response: jsonResponse({ agents: [] }) };
  }

  // ── CHAT: POST /chat/completions ──
  if (method === "POST" && url.includes("/chat/completions")) {
    trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const messages = parsed.messages || [];
    const isStream = parsed.stream === true;
    const tools = parsed.tools || [];

    const resolved = await resolveModel(model);
    model = resolved;

    const cleanTools = (tools || []).filter((t: any) => { const fn = t.function || t; return fn.name && fn.name.length > 0; });
    if (!messages.length) messages.push({ role: "user", content: "Hello" });

    injectIdentity(messages, getModelDisplayName(model), model);
    const scrubbed = scrubTaskComplete(messages, cleanTools);
    const chatMessages = scrubbed.messages;
    const chatTools = scrubbed.tools;
    const chatToolsBn = compressToolDefinitions(chatTools);

    const session = detectSessionSignal(chatMessages);
    if (session) console.log(`[VS LEGACY] Session#${session.sessNum}>${session.keyLabel} ${model} "${extractUserPrompt(chatMessages).substring(0, 120)}"`);

    const extras: Record<string, any> = {};
    if (parsed.temperature !== undefined) extras.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) extras.top_p = parsed.top_p;
    if (parsed.max_tokens !== undefined) extras.max_tokens = parsed.max_tokens;
    if (parsed.tool_choice !== undefined) extras.tool_choice = parsed.tool_choice;
    if (parsed.parallel_tool_calls !== undefined) extras.parallel_tool_calls = parsed.parallel_tool_calls;

    try {
      const resp = await routeChat(model, chatMessages, chatToolsBn, isStream, extras);
      const rawText = await (async () => {
        if (!resp.body) return "";
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
        text += decoder.decode();
        return text;
      })();
      const respCt = resp.headers.get("content-type") || "";
      console.log(`[VS LEGACY] chat resolved=${model} status=${resp.status} ct=${respCt} rawLen=${rawText.length}`);
      vsRespLog(`[BEGIN] url=/chat/completions model=${model} stream=${isStream} x-initiator=${headers["x-initiator"] || "user"}`);
      vsRespLog(`[ROUTE] resolved=${model} status=${resp.status} ct=${respCt} rawLen=${rawText.length} rawPreview=${rawText.slice(0, 800).replace(/\n/g, "\\n")}`);

      const sock = req.clientSocket;
      if (isStream && sock) {
        const upstreamIsSSE = respCt.includes("event-stream") || rawText.trim().startsWith("data:");
        const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`;
        sock.write(respHead);
        if (upstreamIsSSE) {
          sock.write(rawText);
          if (!rawText.endsWith("\n")) sock.write("\n");
          sock.write("data: [DONE]\n\n");
        } else {
          try {
            const data = JSON.parse(rawText);
            const content = data.choices?.[0]?.message?.content || "";
            const id = data.id || `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
            const created = data.created || now;
            let sse = `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`;
            sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":null}]}\n\n`;
            sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
            sse += "data: [DONE]\n\n";
            sock.write(sse);
          } catch {
            sock.write(`data: {"id":"chatcmpl-vs","object":"chat.completion.chunk","created":${now},"model":"${model}","choices":[{"index":0,"delta":{"content":${JSON.stringify(rawText.slice(0, 500))}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
          }
        }
        sock.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      // Non-stream: return as-is
      return { handled: true, response: { statusCode: resp.status, headers: { "content-type": respCt || "application/json" }, body: Buffer.from(rawText) } };
    } catch (e: any) {
      console.log(`[VS LEGACY] chat error: ${e.message}`);
      const mockContent = "I'm ready to help with your coding task. What would you like me to work on?";
      if (isStream) {
        const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
        let sse = `data: {"id":"${id}","object":"chat.completion.chunk","created":${now},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`;
        sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${now},"model":"${model}","choices":[{"index":0,"delta":{"content":"${mockContent}"},"finish_reason":null}]}\n\n`;
        sse += `data: {"id":"${id}","object":"chat.completion.chunk","created":${now},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
        sse += "data: [DONE]\n\n";
        const sock = req.clientSocket;
        if (sock) {
          sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
          sock.write(sse);
          sock.end();
          return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
        }
      }
      return { handled: true, response: jsonResponse({
        id: `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`,
        object: "chat.completion", created: now,
        model, choices: [{ index: 0, message: { role: "assistant", content: mockContent }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }) };
    }
  }

  // ── CHAT: POST /responses (VS22 may use this too) ──
  if (method === "POST" && (url === "/responses" || url.startsWith("/responses?"))) {
    trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const isStream = parsed.stream !== false;
    const tools = parsed.tools || [];
    const resolved = await resolveModel(model);
    model = resolved;

    const { messages: flatMessages, system } = flattenResponsesInput(parsed.input);
    const messages: any[] = [];
    if (system) messages.push({ role: "system", content: system });
    const identityText = compactIdentity(getModelDisplayName(model), model);
    messages.push({ role: "system", content: identityText + (parsed.instructions ? "\n\n" + parsed.instructions : "") });
    for (const m of flatMessages) messages.push(m);

    const scrubbed = scrubTaskComplete(messages, parsed.tools || []);
    const cleanMessages = scrubbed.messages;
    const cleanTools = scrubbed.tools;
    const cleanToolsBn = compressToolDefinitions(cleanTools);

    const extras: Record<string, any> = {};
    if (parsed.reasoning) extras.reasoning = parsed.reasoning;
    if (parsed.temperature !== undefined) extras.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) extras.top_p = parsed.top_p;
    if (parsed.tool_choice !== undefined) extras.tool_choice = parsed.tool_choice;
    if (parsed.max_output_tokens !== undefined) extras.max_output_tokens = parsed.max_output_tokens;

    const resp = await routeChat(model, cleanMessages, cleanToolsBn, isStream, extras);
    const rawText = await (async () => {
      if (!resp.body) return "";
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
      text += decoder.decode();
      return text;
    })();
    const respCt = resp.headers.get("content-type") || "";
    console.log(`[VS LEGACY] /responses resolved=${model} status=${resp.status} ct=${respCt} rawLen=${rawText.length}`);
    vsRespLog(`[BEGIN] url=/responses model=${model} stream=${isStream} x-initiator=${headers["x-initiator"] || "user"}`);
    vsRespLog(`[ROUTE] resolved=${model} status=${resp.status} ct=${respCt} rawLen=${rawText.length} rawPreview=${rawText.slice(0, 800).replace(/\n/g, "\\n")}`);

    const upstreamIsSSE = respCt.includes("event-stream") || rawText.trim().startsWith("data:");
    const sock = req.clientSocket;
    const copilotServiceReqId = headers["x-request-id"] || forge.util.bytesToHex(forge.random.getBytesSync(16));

    if (isStream && sock) {
      const respHead = `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-security-policy: default-src 'none'; sandbox\r\nstrict-transport-security: max-age=31536000\r\naccess-control-allow-origin: *\r\nx-accel-buffering: no\r\nx-copilot-service-request-id: ${copilotServiceReqId}\r\nconnection: close\r\n\r\n`;
      sock.write(respHead);

      if (upstreamIsSSE) {
        // Convert OpenAI SSE chunks to Responses API SSE format
        const converted = streamChatCompletionToResponses(rawText, model);
        sock.write(converted);
      } else {
        try {
          const data = JSON.parse(rawText);
          const content = data.choices?.[0]?.message?.content || "";
          const respOpts: ResponsesOptions = { model, tools: cleanToolsBn, tool_choice: parsed.tool_choice, temperature: parsed.temperature, top_p: parsed.top_p, max_output_tokens: parsed.max_output_tokens, parallel_tool_calls: parsed.parallel_tool_calls, messages: cleanMessages };
          const sseObj = buildResponsesFromChatCompletion(data, respOpts);
          const sseText = streamResponsesObjectToSSE(sseObj, model);
          sock.write(sseText);
        } catch {
          sock.write(`event: response.created\ndata: ${JSON.stringify({ response: { id: `resp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, object: "response", created_at: now, model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: rawText.slice(0, 500) }] }], usage: null } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ response: { id: `resp_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, object: "response", created_at: now, model, status: "completed" } })}\n\n`);
        }
      }
      sock.end();
      return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
    }
    // Non-stream
    try {
      const data = JSON.parse(rawText);
      const respOpts: ResponsesOptions = { model, tools: cleanToolsBn, messages: cleanMessages };
      const sseObj = buildResponsesFromChatCompletion(data, respOpts);
      const sseText = streamResponsesObjectToSSE(sseObj, model);
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(sseText) } };
    } catch {
      return { handled: true, response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Buffer.from(rawText) } };
    }
  }

  // ── CHAT: POST /v1/messages (Anthropic Messages API) ──
  if (method === "POST" && url === "/v1/messages") {
    trackRequest("vs");
    let parsed: any = {};
    try { parsed = JSON.parse(body?.toString() || "{}"); } catch {}
    let model = parsed.model || "";
    const messages = parsed.messages || [];
    const isStream = parsed.stream === true;
    const tools = parsed.tools || [];
    const resolved = await resolveModel(model);
    model = resolved;

    injectIdentity(messages, getModelDisplayName(model), model);
    const cleanTools = (tools || []).filter((t: any) => { const fn = t.function || t; return fn.name && fn.name.length > 0; });
    const scrubbed = scrubTaskComplete(messages, cleanTools);
    const chatMessages = scrubbed.messages;
    const chatTools = scrubbed.tools;
    const chatToolsBn = compressToolDefinitions(chatTools);

    const extras: Record<string, any> = {};
    if (parsed.max_tokens !== undefined) extras.max_tokens = parsed.max_tokens;
    if (parsed.temperature !== undefined) extras.temperature = parsed.temperature;

    try {
      const resp = await routeChat(model, chatMessages, chatToolsBn, isStream, extras);
      const rawText = await (async () => {
        if (!resp.body) return "";
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
        text += decoder.decode();
        return text;
      })();

      const sock = req.clientSocket;
      if (isStream && sock) {
        // Convert OpenAI SSE to Anthropic Messages SSE
        const id = `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
        const msgStart = JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        const msgStop = JSON.stringify({ type: "message_stop" });
        sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\nconnection: close\r\n\r\n`);
        sock.write(`event: message_start\ndata: ${msgStart}\n\n`);

        // Parse OpenAI SSE and convert to Anthropic content_block_delta
        const lines = rawText.split("\n");
        let content = "";
        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const chunk = JSON.parse(line.slice(6));
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                content += delta.content;
                sock.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: delta.content } })}\n\n`);
              }
            } catch {}
          }
        }
        sock.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
        sock.write(`event: message_stop\ndata: ${msgStop}\n\n`);
        sock.end();
        return { handled: true, response: { statusCode: 200, headers: {}, body: Buffer.alloc(0), _streamed: true } };
      }
      // Non-stream: convert OpenAI response to Anthropic format
      try {
        const data = JSON.parse(rawText);
        const content = data.choices?.[0]?.message?.content || "";
        return { handled: true, response: jsonResponse({
          id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: content }],
          model,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }) };
      } catch {
        return { handled: true, response: jsonResponse({ id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, type: "message", role: "assistant", content: [{ type: "text", text: rawText.slice(0, 500) }], model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }) };
      }
    } catch (e: any) {
      console.log(`[VS LEGACY] /v1/messages error: ${e.message}`);
      return { handled: true, response: jsonResponse({ id: `msg_${forge.util.bytesToHex(forge.random.getBytesSync(8))}`, type: "message", role: "assistant", content: [{ type: "text", text: "I'm ready to help." }], model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }) };
    }
  }

  // ── Catch-all: fall through to handleAuth for non-copilot endpoints ──
  // Don't swallow OAuth/login routes — let handleAuth handle them
  if (url.includes("/login/oauth/") || url.includes("/login/device") || url === "/login" || url.startsWith("/login?")) {
    return { handled: false };
  }
  // Don't swallow /user, /user/orgs, /user/repos — let handleAuth handle them
  if (url === "/user" || url.startsWith("/user/") || url === "/user/orgs") {
    return { handled: false };
  }
  // Don't swallow api.github.com root (Octokit.net API discovery) or other
  // api.github.com endpoints (meta, gists, notifications, search, settings, etc.)
  // — let handleAuth handle them so VS gets proper responses.
  if (url === "/" || url.startsWith("/meta") || url.startsWith("/gists") || url.startsWith("/notifications") || url.startsWith("/search/") || url.startsWith("/settings/") || url.startsWith("/orgs/") || url.startsWith("/app") || url.startsWith("/installation")) {
    return { handled: false };
  }

  // Only mock truly unknown copilot API endpoints (prevents upstream errors
  // for VS22-specific paths that real GitHub doesn't have)
  return { handled: true, response: jsonResponse({ ok: true, message: "VS22 mock response" }) };
}
