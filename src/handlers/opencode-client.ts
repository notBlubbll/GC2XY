import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDebug, setModelsList } from "../split-console.ts";
import { getProjectRoot } from "../shared.ts";

// Reasoning cache: stores reasoning_content from DeepSeek responses
// and re-attaches it on subsequent requests (DeepSeek requires this)
const reasoningCache = new Map<string, string>();

// ── Cache Directory ──
let _cacheDir: string | null = null;
function ensureCacheDir(): string {
  if (_cacheDir) return _cacheDir;
  _cacheDir = path.join(getProjectRoot(), ".cache");
  try { fs.mkdirSync(_cacheDir, { recursive: true }); } catch {}
  return _cacheDir;
}

// ── Key Hash Detection ──
function keyHash(): string {
  const all: string[] = [];
  const env = typeof process !== "undefined" ? process.env : {};
  if (env.OPENCODE_API_KEY) all.push(env.OPENCODE_API_KEY);
  if (env.OPENCODE_API_KEYS) {
    try { all.push(...JSON.parse(env.OPENCODE_API_KEYS)); } catch {}
  }
  const deduped = [...new Set(all)].sort();
  if (!deduped.length) return "no-key";
  return crypto.createHash("sha256").update(deduped.join("")).digest("hex");
}

function loadKeyHashFromDisk(): string | null {
  try {
    const p = path.join(ensureCacheDir(), "keyhash.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).h || null;
  } catch { return null; }
}

function saveKeyHashToDisk(h: string): void {
  try {
    const p = path.join(ensureCacheDir(), "keyhash.json");
    const prev = loadKeyHashFromDisk();
    if (prev === h) return;
    fs.writeFileSync(p, JSON.stringify({ h }));
  } catch {}
}

let _lastKeyHash: string | null = null;
function checkKeyChanged(): boolean {
  const h = keyHash();
  if (!_lastKeyHash) _lastKeyHash = loadKeyHashFromDisk();
  if (_lastKeyHash !== null && _lastKeyHash !== h) {
    if (isDebug()) console.log(`\n[KEY CACHE] hash changed: ${(_lastKeyHash || "").slice(0, 8)} → ${h.slice(0, 8)}`);
    _lastKeyHash = h;
    saveKeyHashToDisk(h);
    return true;
  }
  _lastKeyHash = h;
  return false;
}

// ── Key State Persistence ──
function keyStatePath(): string {
  return path.join(ensureCacheDir(), "key-state.json");
}

function keyId(k: string): string {
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 16);
}

function loadKeyState(): Record<string, any> {
  try {
    const p = keyStatePath();
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (isDebug()) console.log(`\n[KEY CACHE] loaded key state from ${p}`);
    return data;
  } catch { return {}; }
}

let _lastKeyStateHash = "";
function saveKeyState(): void {
  try {
    const now = Date.now();
    const state: Record<string, any> = { keys: {} };
    for (const k of keys) {
      const id = keyId(k);
      state.keys[id] = { consecutive429: key429Count.get(k) || 0 };
      if (balancer && balancer.cooldownUntil.has(k)) {
        const until = balancer.cooldownUntil.get(k)!;
        if (until > now) {
          state.keys[id].cooldownUntil = new Date(until).toISOString();
          state.keys[id].cooldownReason = balancer.cooldownReason.get(k) || "429";
        }
      }
    }
    const newHash = JSON.stringify(state);
    if (newHash === _lastKeyStateHash) return;
    _lastKeyStateHash = newHash;
    fs.writeFileSync(keyStatePath(), JSON.stringify(state, null, 2));
  } catch {}
}

// ── Session Tracking (from ZEN-PROXY proxy.js) ──

const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;

const conversationMap = new Map<string, { keyIdx: number; requestCount: number; sessNum: number }>();
let globalSessionCounter = 0;

export function extractUserPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return '';
  const text = (m: any) =>
    typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.find((p: any) => p?.type === 'text')?.text || '' : '');
  const user = [...messages].reverse().find((m: any) => m.role === 'user');
  if (!user) return '';
  return text(user).replace(/^\[[^\]]+\]\s*/, '');
}

export function fingerprintPayload(messages: any[]): string | null {
  if (!Array.isArray(messages)) return null;
  const text = (m: any) =>
    typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.find((p: any) => p?.type === 'text')?.text || '' : '');
  let idx = messages.findIndex((m: any) => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (idx < 0) idx = messages.findIndex((m: any) => m.role === 'user');
  if (idx < 0) return null;
  const raw = text(messages[idx]);
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, '');
  return crypto.createHash('md5').update(stripped).digest('hex').slice(0, 12);
}

export function detectSessionSignal(messages: any[]): { sessNum: number; keyIdx: number; keyLabel: string } | null {
  const fingerprint = fingerprintPayload(messages);
  if (!fingerprint) return null;

  loadKeys();

  const entry = conversationMap.get(fingerprint);
  if (entry !== undefined) {
    entry.requestCount++;
    const label = keys[entry.keyIdx] ? `Key${entry.keyIdx + 1}` : `Key${entry.keyIdx + 1}`;
    return { sessNum: entry.sessNum, keyIdx: entry.keyIdx, keyLabel: label };
  }

  let keyIdx = 0;
  if (keys.length > 1) {
    const idx = Math.floor(Math.random() * keys.length);
    keyIdx = idx;
  }
  const newEntry = { keyIdx, requestCount: 1, sessNum: ++globalSessionCounter };
  conversationMap.set(fingerprint, newEntry);

  const text = (m: any) =>
    typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.find((p: any) => p?.type === 'text')?.text || '' : '');
  let stampIdx = messages.findIndex((m: any) => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (stampIdx < 0) stampIdx = messages.findIndex((m: any) => m.role === 'user');
  const m = messages[stampIdx];
  const curLabel = `Key${keyIdx + 1}|sess${newEntry.sessNum}`;
  const setter = (c: any) => {
    if (typeof c === 'string') return `[${curLabel}] ${c}`;
    if (Array.isArray(c)) {
      const b = c.find((p: any) => p?.type === 'text');
      if (b) b.text = `[${curLabel}] ${b.text}`;
    }
    return c;
  };
  if (m) m.content = setter(m.content);

  return { sessNum: newEntry.sessNum, keyIdx, keyLabel: `Key${keyIdx + 1}` };
}

export function storeReasoning(content: string, reasoning: string) {
  if (!content || !reasoning) return;
  reasoningCache.set(`r:${content.slice(0, 100)}`, reasoning);
  reasoningCache.set("r:last", reasoning);
}

function injectCachedReasoning(messages: any[], modelId: string): any[] {
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

const CONFIG = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  baseUrlFree: "https://opencode.ai/zen/v1",
  maxRetries: 3,
};

const COOLDOWN_429_FIRST = 5 * 60 * 60 * 1000;
const COOLDOWN_429_SECOND = 7 * 24 * 60 * 60 * 1000;
const COOLDOWN_429_RETRY = 30 * 1000;
const CONSECUTIVE_429_THRESHOLD = 10;
const RETRY_DELAY_429 = 3 * 1000;

let keys: string[] = [];
let balancer: ApiBalancer | null = null;
const key429Count = new Map<string, number>();
let zen429Until = 0;

function tryLoadEnvFile() {
  try {
    const p = path.join(getProjectRoot(), ".config", ".env");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*(OPENCODE_API_KEYS?|OPENCODE_SESSION|ZENITH_SESSION|ZENITH_API_KEY)\s*=\s*(.+)/);
        if (m) {
          let val = m[2].replace(/^["']|["']$/g, "").trim();
          if (val && !process.env[m[1]]) {
            process.env[m[1]] = val;
          }
        }
      }
    }
  } catch {}
}

function loadKeys() {
  if (!process.env.OPENCODE_API_KEY && !process.env.OPENCODE_API_KEYS) {
    tryLoadEnvFile();
  }
  const env = typeof process !== "undefined" ? process.env : {};
  let newKeys: string[] = [];
  if (env.OPENCODE_API_KEYS) {
    try { newKeys = JSON.parse(env.OPENCODE_API_KEYS).filter((k: string) => k.length > 5); } catch {}
  } else if (env.OPENCODE_API_KEY && env.OPENCODE_API_KEY.length > 5) {
    newKeys = [env.OPENCODE_API_KEY];
  }
  const changed = keys.length !== newKeys.length || keys.some((k, i) => k !== newKeys[i]);
  keys = newKeys;
  if (keys.length > 0 && (!balancer || changed)) {
    const savedState = loadKeyState();
    balancer = new ApiBalancer(keys, savedState);
  }
}

class ApiBalancer {
  keys: string[];
  pool: string[] = [];
  cooldownUntil = new Map<string, number>();
  cooldownReason = new Map<string, string>();

  constructor(keys: string[], savedState: Record<string, any> = {}) {
    this.keys = keys;
    this._restoreState(savedState);
  }

  _restoreState(savedState: Record<string, any>) {
    const keyMap: Record<string, string> = {};
    for (const k of this.keys) keyMap[keyId(k)] = k;
    let restored = 0;
    let expired = 0;
    for (const [id, info] of Object.entries(savedState.keys || {})) {
      const fullKey = keyMap[id];
      if (!fullKey) continue;
      const i = info as any;
      if (i.cooldownUntil) {
        const until = new Date(i.cooldownUntil).getTime();
        if (until > Date.now()) {
          this.cooldownUntil.set(fullKey, until);
          if (i.cooldownReason) this.cooldownReason.set(fullKey, i.cooldownReason);
          restored++;
        } else {
          expired++;
        }
      }
      if (i.consecutive429) key429Count.set(fullKey, i.consecutive429);
    }
    if (restored > 0 || expired > 0) {
      if (isDebug()) console.log(`\n[KEY CACHE] restored ${restored} cooldown(s), skipped ${expired} expired`);
    }
  }

  _refillPool() {
    const now = Date.now();
    this.pool = [];
    for (const key of this.keys) {
      if (this.cooldownUntil.has(key) && this.cooldownUntil.get(key)! > now) continue;
      this.pool.push(key);
    }
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  hasAvailable(): boolean {
    const now = Date.now();
    for (const key of this.keys) {
      if (!this.cooldownUntil.has(key) || this.cooldownUntil.get(key)! <= now) return true;
    }
    return false;
  }

  getNextKey(): string {
    if (this.pool.length === 0) this._refillPool();
    return this.pool.pop() || "";
  }

  mark429(key: string, resetSeconds = 0) {
    const count = (key429Count.get(key) || 0) + 1;
    key429Count.set(key, count);
    let cdMs: number;
    if (resetSeconds > 0) {
      cdMs = resetSeconds * 1000;
    } else if (count >= CONSECUTIVE_429_THRESHOLD) {
      cdMs = this.cooldownUntil.has(key) && this.cooldownUntil.get(key)! > Date.now()
        ? COOLDOWN_429_SECOND : COOLDOWN_429_FIRST;
    } else {
      cdMs = COOLDOWN_429_RETRY;
    }
    this.cooldownUntil.set(key, Date.now() + cdMs);
    this.cooldownReason.set(key, "429");
    saveKeyState();
  }

  mark401(key: string) {
    const cdMs = 60 * 60 * 1000;
    this.cooldownUntil.set(key, Date.now() + cdMs);
    this.cooldownReason.set(key, "401");
    saveKeyState();
  }

  mark402(key: string, errorText = "") {
    const dayMatch = errorText.match(/resets?\s+in\s+(\d+)\s+days?/i);
    const days = dayMatch ? parseInt(dayMatch[1]) + 1 : 14;
    const cdMs = Math.min(days * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
    this.cooldownUntil.set(key, Date.now() + cdMs);
    this.cooldownReason.set(key, "402");
    saveKeyState();
  }

  markSuccess(key: string) {
    key429Count.set(key, 0);
    this.cooldownUntil.delete(key);
    this.cooldownReason.delete(key);
    saveKeyState();
  }
}

function withKey(pinnedKeyIdx?: number): string {
  loadKeys();
  if (!keys.length) return "";
  if (pinnedKeyIdx !== undefined && pinnedKeyIdx >= 0 && pinnedKeyIdx < keys.length) {
    return keys[pinnedKeyIdx];
  }
  if (!balancer) return keys[0] || "";
  return balancer.getNextKey();
}

function parseRetryAfter(resp: Response): number {
  const val = resp.headers.get("Retry-After");
  if (!val) return 0;
  const secs = parseInt(val, 10);
  if (!isNaN(secs) && secs > 0) return secs;
  const ms = Date.parse(val);
  if (!isNaN(ms)) return Math.max(0, Math.round((ms - Date.now()) / 1000));
  return 0;
}

function getModelTier(modelId: string): "go" | "free" | "poll" {
  const l = modelId.toLowerCase();
  if (l.startsWith("pol/")) return "poll";
  if (l.endsWith("-free") || l === "big-pickle" || l === "nemotron-3-super-free" || l === "ring-2.6-1t-free") return "free";
  return "go";
}

function normalizeTool(t: any): any {
  if (!t) return t;
  // Already in proper OpenAI format
  if (t.type === "function" && t.function?.name) return t;
  // Has function wrapper but no type
  if (t.function?.name) return { type: "function", function: t.function };
  // Anthropic format: {name, description, input_schema}
  if (t.name && t.input_schema) return { type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema } };
  // Simple format: {name, description, parameters}
  if (t.name) return { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } };
  // Fallback with available properties
  return { type: "function", function: { name: t.function?.name || t.name || "unknown", description: t.description || t.function?.description || "", parameters: t.parameters || t.input_schema || t.function?.parameters || {} } };
}

function normalizeToolChoice(tc: any): any {
  if (tc === undefined || tc === null || typeof tc === "string") return tc;
  // Anthropic format: {type: "auto"|"any"} → "auto"
  if (tc.type === "auto" || tc.type === "any") return "auto";
  // Anthropic format: {type: "tool", name: "..."} → OpenAI {type: "function", function: {name}}
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  // Already OpenAI format or pass-through
  return tc;
}

export async function chatCompletion(modelId: string, messages: any[], tools?: any[], stream = true, extra: Record<string, any> = {}, pinnedKeyIdx?: number): Promise<Response> {
  loadKeys();
  const tier = getModelTier(modelId);
  const isFree = tier === "free" || tier === "poll";
  const isPoll = tier === "poll";

  if (isFree && zen429Until > Date.now()) {
    throw new Error("Zen free tier is throttled. Try again later.");
  }

  const base = isPoll ? "https://text.pollinations.ai/openai" : (isFree ? CONFIG.baseUrlFree : CONFIG.baseUrl);
  const url = `${base}/chat/completions`;
  const key = withKey(pinnedKeyIdx);

  // Extract and normalize tool_choice from extra before body spread
  let _toolChoice: any;
  if (extra.tool_choice !== undefined) {
    _toolChoice = normalizeToolChoice(extra.tool_choice);
    delete extra.tool_choice;
  }

  const injected = injectCachedReasoning(messages, modelId);
  const body: any = { ...extra };
  body.model = isPoll ? modelId.replace(/^pol\//, "") : modelId;
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

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!isPoll) {
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    } else if (!isFree) {
      if (balancer && !balancer.hasAvailable()) {
        throw new Error("All API keys are rate-limited. Please wait for cooldown to expire.");
      }
      throw new Error("No API key configured. Free tier models can be used without a key.");
    }
  }

  // Log full request details for debugging
  const logHeaders = { ...headers, Authorization: headers["Authorization"] ? `${headers["Authorization"].slice(0, 15)}...` : "(none)" };
  let logBody = "";
  try { logBody = JSON.stringify({ model: body.model, stream: body.stream, max_tokens: body.max_tokens, reasoningEffort: body.reasoningEffort, msgs: body.messages?.length || 0, tools: body.tools?.length || 0 }); } catch { logBody = "(stringify error)"; }
  console.log(`[OPENCODE] POST ${url} | headers=${JSON.stringify(logHeaders)} | body=${logBody}`);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 45000);
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
      const h2: Record<string, string> = { "Content-Type": "application/json" };
      if (key) h2["Authorization"] = `Bearer ${key}`;
      resp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
      if (resp.ok) return resp;
    }
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    // Report ALL upstream errors to console for debugging
    const statusStr = `${resp.status}`;
    const preview = txt.slice(0, 500);
    const modelInfo = `${modelId} (${modelId.replace(/^pol\//, "")} via ${isPoll ? "poll" : isFree ? "zen" : "go"})`;
    const service = isPoll ? "text.pollinations.ai" : isFree ? CONFIG.baseUrlFree : CONFIG.baseUrl;
    const urlShort = url.replace(/https?:\/\//, "");
    const toolCount = tools?.length || 0;
    const msgCount = messages?.length || 0;
    const firstMsg = messages?.find((m: any) => m.role === "user");
    let umsg = "(none)";
    try { umsg = typeof firstMsg?.content === "string" ? firstMsg.content.slice(0, 100) : JSON.stringify(firstMsg?.content).slice(0, 100); } catch {}
    const bd = txt ? txt.slice(0, 500) : "(empty)";
    const hx = Buffer.from(txt || "").slice(0, 100).toString("hex");
    console.log(`[UPSTREAM] ${statusStr} ${modelInfo} @ ${urlShort} | url=${url} | msgs=${msgCount} tools=${toolCount} | msg="${umsg}" | body="${bd}" | hex="${hx}"`);
    if (resp.status === 429 && isFree) {
      zen429Until = Date.now() + 60 * 1000;
    }
    if (resp.status === 429 && key && !isFree) {
      const resetSec = parseRetryAfter(resp);
      if (balancer) balancer.mark429(key, resetSec);
      if (balancer && !balancer.hasAvailable()) {
        throw new Error("All API keys are rate-limited. Try again later.");
      }
      // Retry once with different key
      const newKey = withKey();
      if (newKey) {
        const h2: Record<string, string> = { "Content-Type": "application/json" };
        if (newKey) h2["Authorization"] = `Bearer ${newKey}`;
        const retryResp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
        if (retryResp.ok) return retryResp;
        const retryTxt = await retryResp.text().catch(() => "");
        console.log(`[UPSTREAM] retry failed: ${retryResp.status} body: ${retryTxt.slice(0, 500)}`);
        throw new Error(`API ${retryResp.status}: ${retryTxt}`);
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    if (resp.status === 402 && key && balancer) {
      balancer.mark402(key, txt);
      if (!balancer.hasAvailable()) {
        throw new Error("All API keys have reached their usage limits. Try again later or use poll/free models.");
      }
      const newKey = withKey();
      if (newKey) {
        const h2: Record<string, string> = { "Content-Type": "application/json" };
        h2["Authorization"] = `Bearer ${newKey}`;
        const retryResp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
        if (retryResp.ok) return retryResp;
        const retryTxt = await retryResp.text().catch(() => "");
        console.log(`[UPSTREAM] retry failed: ${retryResp.status} body: ${retryTxt.slice(0, 500)}`);
        throw new Error(`API ${retryResp.status}: ${retryTxt}`);
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    if (resp.status === 401 && key && balancer) {
      balancer.mark401(key);
      const newKey = withKey();
      if (newKey) {
        const h2: Record<string, string> = { "Content-Type": "application/json" };
        h2["Authorization"] = `Bearer ${newKey}`;
        const retryResp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
        if (retryResp.ok) return retryResp;
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    throw new Error(`API ${resp.status}: ${txt}`);
  }

  if (key) balancer?.markSuccess(key);
  return resp;
}

// ── Per-Provider Model Caching ──

type Provider = "go" | "poll" | "zen";

function modelDiskPath(provider: Provider): string {
  return path.join(ensureCacheDir(), `models-${provider}.json`);
}

function loadProviderModels(provider: Provider): string[] | null {
  try {
    const p = modelDiskPath(provider);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const h = keyHash();
    if (data._keyHash !== h) {
      if (isDebug()) console.log(`\n[MODEL CACHE:${provider.toUpperCase()}] key hash changed — re-fetching`);
      return null;
    }
    return data._modelIds || null;
  } catch { return null; }
}

function saveProviderModels(provider: Provider, ids: string[]): void {
  try {
    ensureCacheDir();
    fs.writeFileSync(modelDiskPath(provider), JSON.stringify({ _modelIds: ids, _keyHash: keyHash() }));
    if (isDebug()) console.log(`\n[MODEL CACHE:${provider.toUpperCase()}] saved ${ids.length} model IDs`);
  } catch {}
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoModels(goKey: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (goKey) headers["Authorization"] = `Bearer ${goKey}`;
    const resp = await fetchWithTimeout("https://opencode.ai/zen/go/v1/models", { headers });
    if (resp.ok) {
      const data: any = await resp.json();
      return (data?.data || []).map((m: any) => typeof m === "string" ? m : m.id || "").filter((id: string) => id.length > 0);
    }
    if (isDebug()) console.log(`\n[MODEL CACHE:GO] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[MODEL CACHE:GO] fetch error: ${e.message}`);
  }
  return [];
}

async function fetchPollinationsModels(): Promise<string[]> {
  try {
    const resp = await fetchWithTimeout("https://text.pollinations.ai/models");
    if (resp.ok) {
      const data: any = await resp.json();
      return (data || []).map((m: any) => `pol/${m.name}`).filter((id: string) => id.length > 4);
    }
    if (isDebug()) console.log(`\n[MODEL CACHE:POLL] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[MODEL CACHE:POLL] fetch error: ${e.message}`);
  }
  return [];
}

// ── Real context window cache (from models.dev) ──
let _ctxCache: Record<string, number> | null = null;
let _visionSet: Set<string> | null = null;
let _familyCache: Record<string, string> = {};
let _nameCache: Record<string, string> = {};

async function fetchModelCtxMap(): Promise<Record<string, number>> {
  if (_ctxCache) return _ctxCache;
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
      for (const ns of ["opencode-go", "opencode"]) {
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
  return _ctxCache || {};
}

export function getModelCtx(id: string): number {
  return _ctxCache?.[id] || 0;
}

export function modelHasVision(id: string): boolean {
  return _visionSet?.has(id) ?? false;
}

export function getModelDisplayName(id: string): string {
  const cached = _nameCache?.[id];
  if (cached) {
    const cleaned = cached.replace(/-/g, " ").replace(/\bV(?=\d)/g, "v");
    return cleaned;
  }
  const base = id.split("/").pop() || id;
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

// ── Per-provider model ID caches ──
let _cachedGoIds: string[] | null = null;
let _cachedPollIds: string[] | null = null;
let _providersInitialized = false;

async function initProviderModels(provider: Provider, goKey: string): Promise<string[]> {
  const diskIds = loadProviderModels(provider);
  if (diskIds && diskIds.length > 0) {
    if (isDebug()) console.log(`\n[MODEL CACHE:${provider.toUpperCase()}] loaded ${diskIds.length} from disk`);
    return diskIds;
  }

  let fetched: string[] = [];
  if (provider === "go") {
    fetched = await fetchGoModels(goKey);
  } else if (provider === "poll") {
    fetched = await fetchPollinationsModels();
  }

  if (fetched.length > 0) {
    saveProviderModels(provider, fetched);
  }
  return fetched;
}

export async function initModels(): Promise<string[]> {
  if (_providersInitialized && _cachedGoIds) {
    return [...new Set([..._cachedGoIds, ...(_cachedPollIds || [])])];
  }

  checkKeyChanged();

  const env = typeof process !== "undefined" ? process.env : {};
  let goKey = "";
  if (env.OPENCODE_API_KEYS) {
    try { goKey = JSON.parse(env.OPENCODE_API_KEYS).find((k: string) => k.length > 5) || ""; } catch {}
  } else if (env.OPENCODE_API_KEY) {
    goKey = env.OPENCODE_API_KEY;
  }

  const [goIds, pollIds] = await Promise.all([
    initProviderModels("go", goKey),
    initProviderModels("poll", ""),
    fetchModelCtxMap(),
  ]);

  _cachedGoIds = goIds;
  _cachedPollIds = pollIds;
  _providersInitialized = true;

  const allIds = [...new Set([...goIds, ...pollIds])];
  setModelsList(allIds);
  if (isDebug()) console.log(`\n[MODEL CACHE] init complete: ${allIds.length} models (${goIds.length} go, ${pollIds.length} poll)`);
  return allIds;
}

export function getModelIds(): string[] {
  if (!_providersInitialized) return [];
  return [...new Set([...(_cachedGoIds || []), ...(_cachedPollIds || [])])];
}

export function getProviderModelIds(provider: Provider): string[] {
  if (provider === "go") return _cachedGoIds || [];
  if (provider === "poll") return _cachedPollIds || [];
  return [];
}

export function getKeyStatus(): any[] {
  loadKeys();
  if (!balancer) {
    return keys.map(k => ({
      keyPrefix: k ? `${k.slice(0, 6)}...${k.slice(-4)}` : "none",
      status: "active",
    }));
  }
  const now = Date.now();
  return balancer.keys.map(k => {
    const short = `${k.slice(0, 6)}...${k.slice(-4)}`;
    let status = "active";
    let reason: string | null = null;
    if (balancer!.cooldownUntil.has(k)) {
      const until = balancer!.cooldownUntil.get(k)!;
      if (until > now) {
        reason = balancer!.cooldownReason.get(k) || null;
        status = reason === "401" ? "auth_denied" : "cooldown";
      }
    }
    return { keyPrefix: short, status, reason, consecutive429: key429Count.get(k) || 0 };
  });
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
};


