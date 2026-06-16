import * as fs from "node:fs";
import * as path from "node:path";
import { isDebug } from "../split-console.ts";
import { getProjectRoot, normalizeTool, normalizeToolChoice } from "../shared.ts";

// Reasoning cache: stores reasoning_content from DeepSeek responses
// and re-attaches it on subsequent requests (DeepSeek requires this)
const reasoningCache = new Map<string, string>();

export function storeReasoning(content: string, reasoning: string) {
  if (!content || !reasoning) return;
  reasoningCache.set(`r:${content.slice(0, 100)}`, reasoning);
  reasoningCache.set("r:last", reasoning);
}

export function injectCachedReasoning(messages: any[], modelId: string): any[] {
  if (reasoningCache.size === 0) return messages;
  const cached = reasoningCache.get("r:last");
  if (!cached) return messages;
  const isDeepSeek = modelId.toLowerCase().includes("deepseek");
  return messages.map((msg: any) => {
    if (msg.role !== "assistant") return msg;
    if (msg.reasoning_content || msg.reasoning) return msg;
    if (isDeepSeek) {
      // DeepSeek requires reasoning_content on ALL assistant messages
      return { ...msg, reasoning_content: cached };
    }
    const byContent = reasoningCache.get(`r:${(msg.content || "").slice(0, 100)}`);
    if (byContent) return { ...msg, reasoning_content: byContent };
    return msg;
  });
}

export interface OpenAIChatOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  messages: any[];
  tools?: any[];
  stream?: boolean;
  extra?: Record<string, any>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function openAIChatCompletion(opts: OpenAIChatOptions): Promise<Response> {
  const {
    baseUrl,
    apiKey,
    modelId,
    messages,
    tools,
    stream = true,
    extra = {},
    headers: extraHeaders = {},
    timeoutMs = 45000,
  } = opts;

  // Extract and normalize tool_choice from extra before body spread
  let _toolChoice: any;
  if (extra.tool_choice !== undefined) {
    _toolChoice = normalizeToolChoice(extra.tool_choice);
  }

  const injected = injectCachedReasoning(messages, modelId);
  const body: any = { ...extra };
  body.model = modelId;
  body.messages = injected.map((msg: any) => {
    const out: any = { role: msg.role, content: msg.content };
    if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
    if (msg.reasoning) out.reasoning = msg.reasoning;
    return out;
  });
  body.stream = stream;
  if (body.stream === false) delete body.stream;
  // Normalize tools with format-agnostic helper
  if (tools !== undefined) {
    body.tools = tools.length ? tools.map(normalizeTool) : undefined;
  } else if (body.tools?.length) {
    body.tools = body.tools.map(normalizeTool);
  }
  // Set tool_choice explicitly after spread so it's never overwritten by extra
  if (_toolChoice !== undefined) body.tool_choice = _toolChoice;
  const modelIdLower = modelId.toLowerCase();
  // DeepSeek min tokens — ensures enough room for thinking output
  if (modelIdLower.includes("deepseek") && (body.max_tokens == null || body.max_tokens < 1024)) {
    body.max_tokens = 1024;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = `${baseUrl}/chat/completions`;
  const logHeaders = { ...headers, Authorization: headers["Authorization"] ? `${headers["Authorization"].slice(0, 15)}...` : "(none)" };
  let logBody = "";
  try { logBody = JSON.stringify({ model: body.model, stream: body.stream, max_tokens: body.max_tokens, reasoningEffort: body.reasoningEffort, msgs: body.messages?.length || 0, tools: body.tools?.length || 0 }); } catch { logBody = "(stringify error)"; }
  console.log(`[OPENAI] POST ${url} | headers=${JSON.stringify(logHeaders)} | body=${logBody}`);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
  } finally {
    clearTimeout(timeout);
  }

  // Handle DeepSeek reasoning_content error: retry without reasoningEffort
  if (!resp.ok && modelIdLower.includes("deepseek") && body.reasoningEffort) {
    const errText = await resp.text().catch(() => "");
    if (errText.includes("reasoning_content") && errText.includes("must be passed back")) {
      console.log(`\n[DEEPSEEK] reasoning_content error on first request — retrying without reasoningEffort`);
      delete body.reasoningEffort;
      body.max_tokens = 2048;
      const h2: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
      if (apiKey) h2["Authorization"] = `Bearer ${apiKey}`;
      resp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
    }
  }

  return resp;
}

// ── Real context window cache (from models.dev) ──
let _ctxCache: Record<string, number> | null = null;
let _visionSet: Set<string> | null = null;
let _familyCache: Record<string, string> = {};
let _nameCache: Record<string, string> = {};

export async function initModelCtxMap(): Promise<void> {
  if (_ctxCache) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch("https://models.dev/api.json", { signal: ctrl.signal });
    clearTimeout(t);
    if (resp.ok) {
      const md: any = await resp.json();
      const ctx: Record<string, number> = {};
      const vis = new Set<string>();
      const fam: Record<string, string> = {};
      const nameCache: Record<string, string> = {};
      for (const ns of Object.keys(md || {})) {
        for (const [id, info] of Object.entries(md[ns]?.models || {})) {
          const entry = info as any;
          const limit = entry?.limit;
          if (limit?.context) ctx[id] = limit.context;
          const mods = entry?.modalities;
          if (mods?.input?.includes("image")) vis.add(id);
          if (entry?.family) fam[id] = entry.family;
          if (entry?.name) nameCache[id] = entry.name;
        }
      }
      if (Object.keys(ctx).length > 0) {
        _ctxCache = ctx;
        _visionSet = vis;
        _familyCache = fam;
        _nameCache = nameCache;
        if (isDebug()) console.log(`\n[MODEL CTX] loaded ${Object.keys(ctx).length} context lengths from models.dev`);
      }
    }
  } catch (e: any) {
    if (isDebug()) console.log(`\n[MODEL CTX] fetch error: ${e.message}`);
  }
}

export function getModelCtx(id: string): number {
  return _ctxCache?.[id] || 0;
}

export function modelHasVision(id: string): boolean {
  return _visionSet?.has(id) ?? false;
}

export function getModelDisplayName(id: string): string {
  // Check display name override first
  const override = _displayNameOverrides[id];
  if (override) return override;
  const cached = _nameCache?.[id];
  if (cached) {
    const cleaned = cached.replace(/-/g, " ").replace(/\bV(?=\d)/g, "v");
    return cleaned;
  }
  let base = id.split("/").pop() || id;
  // Strip provider prefix from Umans model IDs so category stays separate
  base = base.replace(/^umans-/i, "");
  return base.split("-").map((p, i) => {
    const first = p.charAt(0).toUpperCase() + p.slice(1);
    if (p.length === 1 && p === "v" && i > 0) return p;
    return first;
  }).join(" ").replace(/(\d)\.(\d)/g, "$1.$2").replace(/\bV(?=\d)/g, "v");
}

function normalizeFamily(raw: string): string {
  let f = raw.replace(/^thinking-/, "");
  const idx = f.indexOf("-");
  if (idx > 0) f = f.slice(0, idx);
  f = f.replace(/[\d.]+$/, "");
  return f || raw;
}

export function getModelFamily(id: string): string {
  const fromApi = _familyCache?.[id];
  if (fromApi) return normalizeFamily(fromApi);
  const fromInfo = MODEL_INFO[id]?.family;
  if (fromInfo) return normalizeFamily(fromInfo);
  return "";
}

// ── Model Display Name Overrides (from config.json modelDisplayNames) ──
let _displayNameOverrides: Record<string, string> = {};

export function loadDisplayNameOverrides() {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (c.modelDisplayNames && typeof c.modelDisplayNames === "object") {
        _displayNameOverrides = c.modelDisplayNames;
      }
    }
  } catch {}
}

export function getDisplayNameOverride(id: string): string | null {
  return _displayNameOverrides[id] || null;
}

export function setDisplayNameOverride(id: string, name: string) {
  if (name) {
    _displayNameOverrides[id] = name;
  } else {
    delete _displayNameOverrides[id];
  }
  // Persist to config.json
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    let config: any = {};
    if (fs.existsSync(p)) {
      config = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    config.modelDisplayNames = { ..._displayNameOverrides };
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
  } catch {}
}

// ── Model Metadata (for family lookups) ──
const MODEL_INFO: Record<string, { family: string; paramCount: number; contextLength: number; capabilities: string[] }> = {
  "deepseek-v4-pro": { family: "deepseek4", paramCount: 1600000000000, contextLength: 1048576, capabilities: ["completion", "tools", "thinking"] },
  "deepseek-v4-flash": { family: "deepseek4", paramCount: 158000000000, contextLength: 1048576, capabilities: ["completion", "tools", "thinking"] },
  "glm-5.1": { family: "glm", paramCount: 756000000000, contextLength: 202752, capabilities: ["thinking", "completion", "tools"] },
  "glm-5": { family: "glm", paramCount: 540000000000, contextLength: 202752, capabilities: ["thinking", "completion", "tools"] },
  "kimi-k2.6": { family: "kimi-k2", paramCount: 1040000000000, contextLength: 262144, capabilities: ["vision", "thinking", "completion", "tools"] },
  "kimi-k2.5": { family: "kimi-k2", paramCount: 1040000000000, contextLength: 262144, capabilities: ["thinking", "completion", "tools"] },
  "minimax-m2.7": { family: "minimax-m2", paramCount: 229000000000, contextLength: 196608, capabilities: ["completion", "tools", "thinking"] },
  "minimax-m2.5": { family: "minimax-m2", paramCount: 200000000000, contextLength: 196608, capabilities: ["completion", "tools", "thinking"] },
  "mimo-v2.5-pro": { family: "mimo", paramCount: 456000000000, contextLength: 262144, capabilities: ["completion", "tools", "thinking"] },
  "mimo-v2.5": { family: "mimo", paramCount: 456000000000, contextLength: 262144, capabilities: ["completion", "tools", "thinking"] },
  "mimo-v2-pro": { family: "mimo", paramCount: 456000000000, contextLength: 262144, capabilities: ["completion", "tools"] },
  "mimo-v2-omni": { family: "mimo", paramCount: 456000000000, contextLength: 262144, capabilities: ["completion", "tools"] },
  "qwen3.6-plus": { family: "qwen3", paramCount: 72000000000, contextLength: 131072, capabilities: ["completion", "tools", "thinking"] },
  "qwen3.5-plus": { family: "qwen3", paramCount: 72000000000, contextLength: 131072, capabilities: ["completion", "tools", "thinking"] },
  "hy3-preview": { family: "hy3", paramCount: 0, contextLength: 131072, capabilities: ["completion", "tools"] },
  "big-pickle": { family: "pickle", paramCount: 0, contextLength: 1000000, capabilities: ["completion", "tools", "thinking"] },
  "nemotron-3-super-free": { family: "nemotron", paramCount: 0, contextLength: 131072, capabilities: ["completion", "tools"] },
  "ring-2.6-1t-free": { family: "ring", paramCount: 0, contextLength: 131072, capabilities: ["completion", "tools", "thinking"] },
};
