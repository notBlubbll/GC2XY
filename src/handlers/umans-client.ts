// UMANS client — account, key pool, usage, and chat completion for api.code.umans.ai
import * as crypto from "node:crypto";
import * as https from "node:https";
import { isDebug } from "../split-console.ts";
import { normalizeTool as sharedNormalizeTool, compressToolDefinitions } from "../shared.ts";

const UMANS_API_BASE = "https://api.code.umans.ai/v1";
const APP_BASE = "https://app.umans.ai";

const UPSTREAM_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  timeout: 300000,
  maxFreeSockets: 64,
  scheduling: "lifo",
});

// ── Response cache (LRU) ──────────────────────────────────────────────────
class ResponseCache {
  private _map = new Map<string, { value: string; time: number }>();
  hits = 0; misses = 0; evictions = 0;
  constructor(public maxSize: number, public ttlMs: number) {}
  get(key: string): string | null {
    const entry = this._map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.time > this.ttlMs) { this._map.delete(key); this.misses++; return null; }
    this._map.delete(key); this._map.set(key, entry); this.hits++;
    return entry.value;
  }
  set(key: string, value: string) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxSize) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) { this._map.delete(oldest); this.evictions++; }
    }
    this._map.set(key, { value, time: Date.now() });
  }
  clear() { this._map.clear(); this.hits = 0; this.misses = 0; this.evictions = 0; }
  get stats() { return { size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses, evictions: this.evictions }; }
  get enabled() { return this.maxSize > 0 && this.ttlMs > 0; }
}
let responseCache = new ResponseCache(100, 60000);

function cacheKey(payload: any, requestedModel: string): string {
  const parts = [requestedModel, payload.stream ? "stream:1" : "stream:0"];
  if (payload.system) parts.push(typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system));
  if (payload.messages) parts.push(JSON.stringify(payload.messages));
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  return crypto.createHash("md5").update(parts.join("||")).digest("hex");
}

export function getUmansCacheStats() { return { ...responseCache.stats, enabled: _config.cacheEnabled }; }
export function clearUmansCache() { responseCache.clear(); }

// ── Shell-tool guard (block git commands in tool_calls) ───────────────────
const SHELL_TOOL_NAMES = /^(bash|shell|run_command_in_terminal|execute_command|run_in_terminal|send_to_terminal|run_vscode_command|create_and_run_task|terminal)$/i;
const GIT_EXECUTABLE_RE = /^(?:[\s]*["'])?(?:[a-zA-Z]:)?(?:[\\\/][^"']+)*[\\\/]?git(?:\.exe)?\b/i;
const SHELL_WRAPPER_RE = /^(?:bash|sh|zsh|cmd|command|powershell|pwsh|fish|csh|ksh)(?:\.exe)?(?:\s+(?:\-[a-zA-Z]+|\/[a-zA-Z])+)*\s+(?:['"]|\-c\s+|\/c\s+)/i;
const GIT_SUBCOMMAND_RE = /\b(git)\s+(?:add|commit|push|pull|clone|fetch|merge|rebase|reset|checkout|clean|rm|mv|status|log|diff|branch|tag|cherry|revert|stash|bisect|blame|init|remote|config|submodule|sparse|worktree|reflog|show|describe|rev|ls|cat)\b/i;

function isGitCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const trimmed = cmd.trim();
  if (GIT_EXECUTABLE_RE.test(trimmed)) return true;
  if (SHELL_WRAPPER_RE.test(trimmed) && GIT_SUBCOMMAND_RE.test(trimmed)) return true;
  return false;
}

function sanitizeShellToolCall(tc: any): any {
  if (!tc || !tc.function) return tc;
  if (!SHELL_TOOL_NAMES.test(tc.function.name || "")) return tc;
  let args: any;
  try { args = JSON.parse(tc.function.arguments || "{}"); } catch { return tc; }
  if (!isGitCommand(args.command)) return tc;
  const blockedMsg = 'echo "BLOCKED: git commands are disabled by proxy policy"';
  if (isDebug()) console.log(`[UMANS-ShellGuard] blocked ${tc.function.name}: ${(args.command || "").substring(0, 200)}`);
  return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ ...args, command: blockedMsg }) } };
}

function sanitizeChatCompletionResponse(body: any): any {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    const msg = choice.message;
    if (!msg || !Array.isArray(msg.tool_calls)) continue;
    msg.tool_calls = msg.tool_calls.map(sanitizeShellToolCall);
  }
  return body;
}

function parseSseEvents(text: string): any[] {
  const events: any[] = [];
  let current: any = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") { if (current) { events.push(current); current = null; } }
    else if (line.startsWith("event:")) { if (!current) current = { data: "" }; current.event = line.slice(6).trim(); }
    else if (line.startsWith("data:")) { if (!current) current = { data: "" }; current.data += (line === "data:" ? "\n" : line.slice(5).trimStart() + "\n"); }
    else if (line.startsWith("id:")) { if (!current) current = { data: "" }; current.id = line.slice(3).trim(); }
    else if (line.startsWith("retry:")) { if (!current) current = { data: "" }; current.retry = line.slice(6).trim(); }
  }
  if (current) events.push(current);
  for (const e of events) e.data = e.data.replace(/\n$/, "");
  return events;
}

function serializeSseEvents(events: any[]): string {
  return events.map((e) => {
    const out: string[] = [];
    if (e.event) out.push(`event: ${e.event}`);
    if (e.id) out.push(`id: ${e.id}`);
    if (e.retry) out.push(`retry: ${e.retry}`);
    if (e.data !== undefined && e.data !== null) for (const line of String(e.data).split(/\r?\n/)) out.push(`data: ${line}`);
    out.push("");
    return out.join("\n");
  }).join("\n") + "\n";
}

function sanitizeSseResponse(text: string): string {
  const events = parseSseEvents(text);
  const accum: Record<number, any> = {};
  for (const e of events) {
    if (e.event === "ping" || !e.data) continue;
    let obj: any;
    try { obj = JSON.parse(e.data); } catch { continue; }
    const delta = obj.choices?.[0]?.delta;
    if (!delta?.tool_calls) continue;
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!accum[idx]) accum[idx] = { index: idx, id: "", type: "function", function: { name: "", arguments: "" } };
      const a = accum[idx];
      if (tc.id) a.id = tc.id;
      if (tc.type) a.type = tc.type;
      if (tc.function?.name) a.function.name += tc.function.name;
      if (tc.function?.arguments != null) a.function.arguments += tc.function.arguments;
    }
  }
  const indices = Object.keys(accum).map(Number).sort((a, b) => a - b);
  const originalTools = indices.map(i => accum[i]);
  const sanitizedTools = originalTools.map(sanitizeShellToolCall);
  let anyBlocked = false;
  for (let i = 0; i < sanitizedTools.length; i++) if (sanitizedTools[i] !== originalTools[i]) { anyBlocked = true; break; }
  if (!anyBlocked) return text;
  const firstEmitted = new Set<number>();
  const outEvents: any[] = [];
  for (const e of events) {
    if (e.event === "ping" || !e.data) { outEvents.push(e); continue; }
    let obj: any;
    try { obj = JSON.parse(e.data); } catch { outEvents.push(e); continue; }
    const delta = obj.choices?.[0]?.delta;
    const toolCalls = delta?.tool_calls;
    if (!Array.isArray(toolCalls)) { outEvents.push(e); continue; }
    let modified = false;
    for (const tc of toolCalls) {
      const idx = tc.index ?? 0;
      const sanitized = sanitizedTools[indices.indexOf(idx)];
      if (!sanitized || sanitized === originalTools[indices.indexOf(idx)] || !tc.function) continue;
      if (!firstEmitted.has(idx)) { tc.function.name = sanitized.function.name; tc.function.arguments = sanitized.function.arguments; firstEmitted.add(idx); }
      else { tc.function.arguments = ""; }
      modified = true;
    }
    if (modified) { delta.tool_calls = toolCalls.filter((tc: any) => tc.id || tc.function?.name || tc.function?.arguments); outEvents.push({ ...e, data: JSON.stringify(obj) }); }
    else outEvents.push(e);
  }
  return serializeSseEvents(outEvents);
}

// ── Reasoning level detection (clone/thinking variants) ────────────────────
// UMANS advertises capabilities.reasoning.levels (e.g. ["low","medium","high","max"]).
// We mirror the vs/models.ts clone approach: append -lo/-md/-hi/-mx to the model
// id and map the selected variant back to a thinking budget on the upstream call.
const REASONING_LEVEL_BUDGETS: Record<string, number> = { low: 8000, medium: 16000, high: 16000, max: 32000 };
const TAG_TO_LEVEL: Record<string, string> = { lo: "low", md: "medium", hi: "high", mx: "max", low: "low", medium: "medium", high: "high", maximum: "max", med: "medium", max: "max" };

function umansLevelToTag(level: string): string | null {
  const l = (level || "").toLowerCase();
  if (l === "low") return "LOW";
  if (l === "medium" || l === "med") return "MEDIUM";
  if (l === "high") return "HIGH";
  if (l === "max" || l === "maximum" || l === "xhigh") return "MAXIMUM";
  return null;
}

export function getUmansThinkingModes(id: string): string[] {
  const info = (modelInfoMap as any)[id];
  if (!info?.capabilities?.reasoning) return [];
  const r = info.capabilities.reasoning;
  if (r.supported !== true) return [];
  if (r.can_disable === false) return [];
  const levels: string[] = Array.isArray(r.levels) ? r.levels : [];
  const tags = levels.map(umansLevelToTag).filter((t): t is string => !!t);
  return [...new Set(tags)];
}

export function parseUmansThinkingTag(modelId: string): { base: string; level: string | null } {
  const clean = (modelId || "").trim();
  if (!clean) return { base: modelId, level: null };
  // suffix format: umans-glm-5.2-mx
  const m = clean.match(/^(.+?)-(lo|md|hi|mx)$/i);
  if (m) return { base: m[1].trim(), level: TAG_TO_LEVEL[m[2].toLowerCase()] || null };
  // bracket format: "umans-glm-5.2 [MX]"
  const b = clean.match(/^(.+?)\s+\[(LO|MD|HI|MX|LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX)\]\s*$/i);
  if (b) return { base: b[1].trim(), level: TAG_TO_LEVEL[b[2].toLowerCase()] || null };
  return { base: clean, level: null };
}

// --- Config interface (populated by dashboard-handler.ts) ---
export interface UmansConfig {
  upstreamBaseURL: string;
  requestTimeout: number;
  maxImages: number;
  keys: { name: string; key: string; session?: string }[];
  enabledModels: string[];
  email: string;
  password: string;
  appSession: string;
  overrideConcurrency?: number;
  visionHandoffEnabled: boolean;
  visionHandoffModel: string;
  visionHandoffPrompt: string;
  cacheEnabled: boolean;
  cacheTtl: number;
  cacheMaxSize: number;
}

let _config: UmansConfig = {
  upstreamBaseURL: UMANS_API_BASE,
  requestTimeout: 15 * 60 * 1000,
  maxImages: 9,
  keys: [],
  enabledModels: [],
  email: "",
  password: "",
  appSession: "",
  visionHandoffEnabled: true,
  visionHandoffModel: "umans-kimi-k2.7",
  visionHandoffPrompt: "",
  cacheEnabled: true,
  cacheTtl: 60 * 1000,
  cacheMaxSize: 100,
};

export function setUmansConfig(cfg: Partial<UmansConfig>) {
  _config = { ..._config, ...cfg };
  if (_keyPool) {
    const filtered = (_config.keys || []).filter(k => k.key && k.key.length > 5);
    _keyPool = new KeyPool(filtered);
  }
  responseCache = new ResponseCache(_config.cacheMaxSize, _config.cacheTtl);
}

export function setUmansVisionHandoff(enabled: boolean, model?: string, prompt?: string) {
  _config.visionHandoffEnabled = enabled;
  if (model !== undefined) _config.visionHandoffModel = model.trim() || "umans-kimi-k2.7";
  if (prompt !== undefined) _config.visionHandoffPrompt = prompt;
}

export function getUmansVisionHandoff() {
  return {
    enabled: _config.visionHandoffEnabled,
    model: _config.visionHandoffModel,
    prompt: _config.visionHandoffPrompt,
  };
}

export function getUmansConfig(): UmansConfig {
  return _config;
}

// --- Dashboard-facing state helpers ---
export function setUmansAppSession(sessionToken: string) {
  _config.appSession = sessionToken;
}

export function setUmansEmail(email: string) {
  _config.email = email;
}

export function setUmansPassword(password: string) {
  _config.password = password;
}

export function setUmansKeys(keys: { name: string; key: string; session?: string }[]) {
  _config.keys = keys;
  refreshKeyPool();
}

export function setUmansEnabledModels(models: string[]) {
  _config.enabledModels = models;
}

export function setUmansCurrentKeyIndex(index: number) {
  setCurrentKeyIndex(index);
}

export function normalizeUsageBucket(raw: any): { bucket: string; requests: number; tokens_in: number; tokens_out: number; tokens_cached: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const isOld = raw.tokens_in === undefined && raw.tokens_out === undefined && raw.requests !== undefined && raw.units !== undefined;
  if (isOld) {
    return {
      bucket: raw.bucket || raw.timestamp || raw.date || "",
      requests: Number(raw.requests) || 0,
      tokens_in: Number(raw.units) || 0,
      tokens_out: 0,
      tokens_cached: 0,
    };
  }
  const bucket = raw.bucket || raw.date || "";
  const requests = Number(raw.requests ?? raw.request_count) || 0;
  const tokensIn = Number(raw.tokens_in) || 0;
  const tokensOut = Number(raw.tokens_out) || 0;
  const cached = Number(raw.tokens_cached_read ?? raw.tokens_cached ?? 0);
  if (!bucket && requests === 0 && tokensIn === 0 && tokensOut === 0 && cached === 0) return null;
  return { bucket, requests, tokens_in: tokensIn, tokens_out: tokensOut, tokens_cached: cached };
}

export function extractUsageBuckets(data: any): { bucket: string; requests: number; tokens_in: number; tokens_out: number; tokens_cached: number }[] | null {
  if (!data || typeof data !== "object") return null;
  let arr: any[] | null = null;
  if (Array.isArray(data.buckets)) arr = data.buckets;
  else if (Array.isArray(data.history)) arr = data.history;
  else if (Array.isArray(data.entries)) arr = data.entries;
  else if (Array.isArray(data.data)) arr = data.data;
  else if (Array.isArray(data)) arr = data;
  if (!arr) return null;
  return arr.map(normalizeUsageBucket).filter((b): b is NonNullable<typeof b> => b !== null);
}

export function getUsageHistoryDateRange(): { from: string; to: string; today: string } {
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to, today: new Date().toISOString().slice(0, 10) };
}

let _umansLoginStateCallback: ((state: any) => void) | null = null;
export function onUmansLoginStateChange(cb: (state: any) => void) {
  _umansLoginStateCallback = cb;
}
function emitLoginState() {
  if (_umansLoginStateCallback) {
    _umansLoginStateCallback({
      loggedIn: !!_config.appSession,
      email: _config.email,
      keys: _config.keys,
      currentKeyIndex: _currentKeyIndex,
      enabledModels: _config.enabledModels,
      userId: concurrencyCache.user_id,
    });
  }
}

// --- Key masking ---
function maskToken(key: string): string {
  if (!key) return "";
  return key.substring(0, 10) + "..." + key.substring(key.length - 4);
}

// --- Key pool ---
interface KeyEntry {
  key: string;
  name: string;
  healthy: boolean;
  lastError: number;
  cooldownMs: number;
}

class KeyPool {
  private _entries: KeyEntry[];
  private _index = 0;
  private _mutex = Promise.resolve();

  constructor(keys: { name: string; key: string }[]) {
    this._entries = keys.map(k => ({ key: k.key, name: k.name || "Key", healthy: true, lastError: 0, cooldownMs: 30000 }));
  }

  private _lock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release: () => void;
    const p = new Promise<void>(r => { release = r; });
    const old = this._mutex;
    this._mutex = p;
    return Promise.resolve().then(() => old).then(fn).finally(() => release());
  }

  acquire(preferredIndex?: number): { key: string; name: string; index: number } | null {
    return this._lock(() => {
      if (this._entries.length === 0) return null;
      const now = Date.now();
      if (preferredIndex !== undefined && preferredIndex >= 0 && preferredIndex < this._entries.length) {
        const pref = this._entries[preferredIndex];
        if (pref && (pref.healthy || now - pref.lastError > pref.cooldownMs)) {
          pref.healthy = true;
          return { key: pref.key, name: pref.name, index: preferredIndex };
        }
      }
      for (let attempt = 0; attempt < this._entries.length; attempt++) {
        const idx = this._index++ % this._entries.length;
        const entry = this._entries[idx];
        if (entry.healthy || now - entry.lastError > entry.cooldownMs) {
          entry.healthy = true;
          return { key: entry.key, name: entry.name, index: idx };
        }
      }
      return null;
    });
  }

  markUnhealthy(index: number, status: number) {
    const entry = this._entries[index];
    if (!entry) return;
    entry.healthy = false;
    entry.lastError = Date.now();
    if (status >= 503) entry.cooldownMs = 60000;
    else if (status >= 502) entry.cooldownMs = 30000;
    else entry.cooldownMs = 10000;
  }

  markHealthy(index: number) {
    const entry = this._entries[index];
    if (!entry) return;
    entry.healthy = true;
    entry.lastError = 0;
  }

  get total() { return this._entries.length; }

  get healthyCount() {
    const now = Date.now();
    return this._entries.filter(e => e.healthy || now - e.lastError > e.cooldownMs).length;
  }

  get state() {
    const now = Date.now();
    return this._entries.map((e, i) => {
      const cool = !e.healthy ? Math.max(0, e.cooldownMs - (now - e.lastError)) : 0;
      let status = "none";
      if (e.key && (e.healthy || cool === 0)) status = "active";
      else if (e.key) status = "cooldown";
      return { name: e.name, status, healthy: e.healthy, remainingCooldown: cool, token: maskToken(e.key), index: i };
    });
  }

  get entries() { return this._entries; }
}

let _keyPool: KeyPool | null = null;
let _currentKeyIndex = 0;

function ensureKeyPool(): KeyPool {
  if (!_keyPool) {
    _keyPool = new KeyPool((_config.keys || []).filter(k => k.key && k.key.length > 5));
  }
  return _keyPool;
}

export function refreshKeyPool() {
  _keyPool = new KeyPool((_config.keys || []).filter(k => k.key && k.key.length > 5));
}

export function setCurrentKeyIndex(index: number) {
  _currentKeyIndex = Math.max(0, index);
  const pool = ensureKeyPool();
  if (_currentKeyIndex >= pool.total) _currentKeyIndex = 0;
  emitLoginState();
}

export function getCurrentKeyIndex(): number {
  return _currentKeyIndex;
}

export async function refreshUmansState(): Promise<{ usage: any; concurrency: any; usageHistory: any; keys: any[]; userId: string | null }> {
  const [usage, concurrency, usageHistory, keys] = await Promise.all([
    fetchUsage({ force: true }).catch(() => null),
    fetchConcurrency().catch(() => ({ concurrent: 0, limit: null, user_id: null })),
    fetchUsageHistory({ force: true }).catch(() => null),
    fetchKeysFromApp().catch(() => []),
  ]);
  return { usage, concurrency, usageHistory, keys, userId: concurrency?.user_id || null };
}

export function getKeyState(): any[] {
  const pool = ensureKeyPool();
  return pool.state;
}

// --- Upstream fetch helpers ---
function headers(key: string, stream = false): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Connection: "keep-alive",
  };
}

export async function getUserInfo(key?: string): Promise<Record<string, any>> {
  const k = key || (_config.keys[0]?.key);
  if (!k) throw new Error("No UMANS API key");
  const url = `${_config.upstreamBaseURL}/models/info`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${k}`, Connection: "keep-alive" },
    signal: AbortSignal.timeout(10000),
    agent: UPSTREAM_AGENT as any,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

export interface ChatCompletionResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream | NodeJS.ReadableStream | null;
}

export async function chatCompletions(payload: any, key: string): Promise<ChatCompletionResult> {
  const isStream = payload?.stream === true;
  const url = `${_config.upstreamBaseURL}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(key, isStream),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(_config.requestTimeout),
    agent: UPSTREAM_AGENT as any,
  });
  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
  return { status: resp.status, headers: responseHeaders, body: resp.body as any };
}

// Native Anthropic Messages API pass-through. UMANS upstream natively supports
// /messages, so Anthropic-format requests are forwarded directly without bridge
// translation. Returns the raw upstream Response (already Anthropic format).
export async function anthropicMessages(payload: any, key: string): Promise<ChatCompletionResult> {
  const isStream = payload?.stream === true;
  const url = `${_config.upstreamBaseURL}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(key, isStream),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(_config.requestTimeout),
    agent: UPSTREAM_AGENT as any,
  });
  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
  return { status: resp.status, headers: responseHeaders, body: resp.body as any };
}

// --- Session affinity ---
let globalSessionCounter = 0;
const conversationMap = new Map<string, { tokenIndex: number; requestCount: number; sessNum: number }>();
const CONVERSATION_MAP_MAX = 10000;
const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;

function touchConversation(fingerprint: string) {
  const session = conversationMap.get(fingerprint);
  if (session) {
    conversationMap.delete(fingerprint);
    conversationMap.set(fingerprint, session);
  }
  return session;
}

function trackConversationSession(fingerprint: string, session: { tokenIndex: number; requestCount: number; sessNum: number }) {
  if (!fingerprint) return;
  if (conversationMap.size >= CONVERSATION_MAP_MAX) {
    const target = Math.floor(CONVERSATION_MAP_MAX * 0.8);
    const iter = conversationMap.keys();
    while (conversationMap.size > target) {
      const key = iter.next().value;
      if (key === undefined) break;
      conversationMap.delete(key);
    }
  }
  conversationMap.delete(fingerprint);
  conversationMap.set(fingerprint, session);
}

function msgText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.find((p: any) => p?.type === "text")?.text || "";
  return "";
}

function extractUserPrompt(payload: any): string {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return "";
  const user = [...msgs].reverse().find((m: any) => m.role === "user");
  if (!user) return "";
  return msgText(user).replace(/^\[[^\]]+\]\s*/, "");
}

function fingerprintPayload(payload: any): string | null {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const idx = msgs.findIndex((m: any) => m.role === "user" && !TITLE_PROMPT_RE.test(msgText(m)));
  const fallbackIdx = msgs.findIndex((m: any) => m.role === "user");
  const target = idx >= 0 ? msgs[idx] : (fallbackIdx >= 0 ? msgs[fallbackIdx] : undefined);
  const raw = msgText(target);
  if (!raw) return null;
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, "");
  return crypto.createHash("md5").update(stripped).digest("hex").slice(0, 12);
}

function stripReasoningContent(payload: any) {
  if (!Array.isArray(payload.messages)) return;
  for (const m of payload.messages) {
    if (m.role === "assistant") {
      delete m.reasoning_content;
      delete m.reasoningContent;
    }
  }
}

function limitImagesInMessages(payload: any, maxImages: number) {
  if (!maxImages || maxImages <= 0) return;
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return;
  const imageParts: { m: any; pi: number; time: number }[] = [];
  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi];
    if (m.role === "system" || !Array.isArray(m.content)) continue;
    for (let pi = 0; pi < m.content.length; pi++) {
      const part = m.content[pi];
      if (part && (part.type === "image_url" || part.type === "image")) imageParts.push({ m, pi, time: mi });
    }
  }
  if (imageParts.length <= maxImages) return;
  const toRemove = imageParts.length - maxImages;
  for (let i = 0; i < toRemove; i++) {
    const { m, pi } = imageParts[i];
    m.content.splice(pi, 1);
  }
}

function stampSessionLabel(payload: any, name: string, sessNum: number) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return;
  const idx = msgs.findIndex((m: any) => m.role === "user");
  if (idx < 0) return;
  const m = msgs[idx];
  const label = `${name}|sess${sessNum}`;
  if (typeof m.content === "string") {
    m.content = `[${label}] ${m.content}`;
  } else if (Array.isArray(m.content)) {
    const textPart = m.content.find((p: any) => p?.type === "text");
    if (textPart) textPart.text = `[${label}] ${textPart.text}`;
  }
}

function normalizeToolSchemas(tools: any[]) {
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function;
    if (!fn || typeof fn !== "object") continue;
    const params = fn.parameters;
    if (!params || typeof params !== "object") continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema: any): Record<string, any> | null {
  const merged: Record<string, any> = {};
  if (schema.definitions && typeof schema.definitions === "object") Object.assign(merged, schema.definitions);
  if (schema["$defs"] && typeof schema["$defs"] === "object") Object.assign(merged, schema["$defs"]);
  return Object.keys(merged).length > 0 ? merged : null;
}

function mergeDefinitions(a: Record<string, any> | null, b: Record<string, any> | null): Record<string, any> | null {
  if (!a && !b) return null;
  return { ...(a || {}), ...(b || {}) };
}

function tryResolveRef(node: any, defs: Record<string, any> | null): any {
  if (!node || typeof node !== "object") return node;
  if (node["$ref"] && typeof node["$ref"] === "string" && defs) {
    const refName = node["$ref"].split("/").pop();
    if (defs[refName]) return { ...defs[refName] };
  }
  return node;
}

function simplifyNullableCombinator(node: any): any {
  if (!node || typeof node !== "object" || !node.anyOf) return node;
  const nonNull = node.anyOf.find((item: any) => item && item.type !== "null");
  const hasNull = node.anyOf.some((item: any) => item && item.type === "null");
  if (hasNull && nonNull) {
    return { ...nonNull, nullable: true };
  }
  return node;
}

function normalizeSchemaMap(node: any, defs: Record<string, any> | null, depth: number): any {
  if (depth <= 0) return JSON.parse(JSON.stringify(node));
  defs = mergeDefinitions(defs, extractDefinitions(node));
  node = tryResolveRef(node, defs);
  node = simplifyNullableCombinator(node);
  if (Array.isArray(node)) {
    return node.map(item => normalizeSchemaMap(item, defs, depth - 1));
  }
  if (node && typeof node === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" || k === "$defs" || k === "definitions") continue;
      if (k === "anyOf" && Array.isArray(v)) {
        const simplified = simplifyNullableCombinator({ anyOf: v });
        if (simplified.nullable) out[k] = [simplified];
        else out[k] = v.map((item: any) => normalizeSchemaMap(item, defs, depth - 1));
      } else if (k === "oneOf" && Array.isArray(v)) {
        out[k] = v.map((item: any) => normalizeSchemaMap(item, defs, depth - 1));
      } else if (k === "allOf" && Array.isArray(v)) {
        out[k] = v.map((item: any) => normalizeSchemaMap(item, defs, depth - 1));
      } else if (k === "items" || k === "additionalProperties" || k === "contains" || k === "propertyNames") {
        out[k] = normalizeSchemaMap(v, defs, depth - 1);
      } else if (k === "properties" && typeof v === "object") {
        const props: Record<string, any> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, any>)) {
          props[pk] = normalizeSchemaMap(pv, defs, depth - 1);
        }
        out[k] = props;
      } else if (k === "required" && Array.isArray(v)) {
        const seen = new Set<string>();
        out[k] = v.filter((item: any) => { if (typeof item !== "string" || seen.has(item)) return false; seen.add(item); return true; });
      } else {
        out[k] = (typeof v === "object" && v !== null) ? normalizeSchemaMap(v, defs, depth - 1) : v;
      }
    }
    return out;
  }
  return node;
}

// --- Model catalog caching ---
let modelCatalogCache: any = null;
let modelCatalogCacheTime = 0;
const MODEL_CATALOG_CACHE_TTL = 5 * 60 * 1000;
let modelDisplayNameMap: Record<string, string> = {};
export let modelInfoMap: Record<string, any> = {};
let _cachedModelIds: string[] = [];
let _modelsInitialized = false;

export async function fetchModelCatalog(key?: string): Promise<Record<string, any>> {
  const k = key || (_config.keys[0]?.key);
  const url = `${_config.upstreamBaseURL}/models/info`;
    const resp = await fetch(url, {
      headers: k ? { Authorization: `Bearer ${k}`, Connection: "keep-alive" } : { Connection: "keep-alive" },
      signal: AbortSignal.timeout(15000),
      agent: UPSTREAM_AGENT as any,
    });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

export async function getCatalogData(): Promise<Record<string, any>> {
  if (modelCatalogCache && Date.now() - modelCatalogCacheTime < MODEL_CATALOG_CACHE_TTL) return modelCatalogCache;
  const data = await fetchModelCatalog();
  modelCatalogCache = data;
  modelCatalogCacheTime = Date.now();
  if (data && typeof data === "object" && !Array.isArray(data.data)) {
    modelDisplayNameMap = {};
    modelInfoMap = {};
    for (const [id, info] of Object.entries(data as Record<string, any>)) {
      if (!info || typeof info !== "object") continue;
      modelInfoMap[id] = info;
      if (info.display_name) modelDisplayNameMap[id] = info.display_name.replace(/^Umans\s+/i, "");
    }
  }
  return data;
}

export function getModelDisplayName(id: string): string {
  if (modelDisplayNameMap[id]) return modelDisplayNameMap[id];
  const base = id.replace(/^umans-/i, "");
  return base.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

export function getEnabledModels(): string[] {
  return _config.enabledModels || [];
}

export async function initModels(): Promise<string[]> {
  if (_modelsInitialized && _cachedModelIds.length > 0) return _cachedModelIds;
  try {
    const data = await getCatalogData();
    if (data && typeof data === "object" && !Array.isArray(data.data)) {
      _cachedModelIds = Object.keys(data).filter(id => id && typeof data[id] === "object");
    } else if (data && Array.isArray(data.data)) {
      _cachedModelIds = data.data.map((m: any) => typeof m === "string" ? m : m.id || "").filter(Boolean);
    }
  } catch (e: any) {
    if (isDebug()) console.log(`[UMANS] initModels failed: ${e.message}`);
  }
  _modelsInitialized = true;
  return _cachedModelIds;
}

export function getModelIds(): string[] {
  if (!_modelsInitialized) initModels().catch(() => {});
  return _cachedModelIds;
}

// ── Vision handoff ──────────────────────────────────────────────────────────
// Models whose capabilities.supports_vision === "via-handoff" (e.g. umans-glm-5.2)
// cannot process images natively. We intercept images in requests to such models,
// send each image to a vision-capable handoff model (default umans-kimi-k2.7), and
// replace the image part with the text description before forwarding to the model.
const DEFAULT_VISION_HANDOFF_PROMPT = `The user has pasted an image into their chat. Describe what you see as if you are directly observing the image. Be thorough but concise. Include:
- All visible elements (objects, text, UI elements, people, etc.)
- Exact transcription of any text
- The context and purpose of the image
- Any relevant technical details

Describe it naturally, as if explaining to someone what you're looking at right now.`;

function needsVisionHandoff(resolvedModel: string): boolean {
  if (!_config.visionHandoffEnabled) return false;
  const info = modelInfoMap[resolvedModel];
  if (!info || !info.capabilities) return false;
  return info.capabilities.supports_vision === "via-handoff";
}

// Resolve a requested model ID to its umans- catalog ID (stripping thinking tags).
function resolveUmansModelId(requestedModel: string): string {
  if (!requestedModel) return requestedModel;
  const { base } = parseUmansThinkingTag(requestedModel);
  if (base.startsWith("umans-")) return base;
  const prefixed = "umans-" + base;
  if (modelInfoMap[prefixed]) return prefixed;
  if (_config.enabledModels.includes(prefixed)) return prefixed;
  if (_config.enabledModels.includes(base)) return base;
  return base;
}

// Walk a content array (OpenAI or Anthropic format) and collect image parts.
function collectImageParts(payload: any): { container: any[]; index: number; dataUri: string }[] {
  const parts: { container: any[]; index: number; dataUri: string }[] = [];
  function walkContentArray(content: any[]) {
    if (!Array.isArray(content)) return;
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url" && part.image_url && part.image_url.url) {
        parts.push({ container: content, index: i, dataUri: part.image_url.url });
      } else if (part.type === "image" && part.source) {
        if (part.source.type === "base64" && part.source.media_type && part.source.data) {
          parts.push({ container: content, index: i, dataUri: `data:${part.source.media_type};base64,${part.source.data}` });
        } else if (part.source.type === "url" && part.source.url) {
          parts.push({ container: content, index: i, dataUri: part.source.url });
        }
      }
      if (Array.isArray(part.content)) walkContentArray(part.content);
    }
  }
  if (payload && Array.isArray(payload.system)) walkContentArray(payload.system);
  if (payload && Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && Array.isArray(m.content)) walkContentArray(m.content);
    }
  }
  return parts;
}

async function analyzeImageViaHandoff(dataUri: string, key: string, keyName: string, sessNum: number, imageIndex: number): Promise<string> {
  const handoffModel = _config.visionHandoffModel || "umans-kimi-k2.7";
  const prompt = _config.visionHandoffPrompt || DEFAULT_VISION_HANDOFF_PROMPT;
  const handoffPayload = {
    model: handoffModel,
    stream: false,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: [
        { type: "text", text: "What do you see in this image?" },
        { type: "image_url", image_url: { url: dataUri } },
      ] },
    ],
  };
  try {
    if (isDebug()) console.log(`[UMANS] [Session#${sessNum}>${keyName}]-[handoff→${handoffModel}]-analyzing image #${imageIndex + 1}`);
    const result = await chatCompletions(handoffPayload, key);
    if (result.status >= 400) {
      const errText = await readBodyText(result.body).catch(() => "");
      console.log(`[UMANS] [Session#${sessNum}>${keyName}]-[handoff→${handoffModel}]-ERROR:${result.status} ${(errText || "").substring(0, 200)}`);
      return `[Image analysis failed: upstream returned HTTP ${result.status}]`;
    }
    const bodyText = await readBodyText(result.body);
    const parsed = JSON.parse(bodyText);
    const description = parsed?.choices?.[0]?.message?.content || "";
    if (!description) return "[Image analysis failed: no text in handoff response]";
    if (isDebug()) console.log(`[UMANS] [Session#${sessNum}>${keyName}]-[handoff→${handoffModel}]-image #${imageIndex + 1} described (${description.length} chars)`);
    return description;
  } catch (e: any) {
    console.log(`[UMANS] [Session#${sessNum}>${keyName}]-[handoff→${handoffModel}]-ERROR: ${e.message}`);
    return `[Image analysis failed: ${e.message}]`;
  }
}

// Replace all image parts in the payload with text descriptions from the handoff model.
async function performVisionHandoff(payload: any, resolvedModel: string, key: string, keyName: string, sessNum: number): Promise<number> {
  if (!needsVisionHandoff(resolvedModel)) return 0;
  const imageParts = collectImageParts(payload);
  if (imageParts.length === 0) return 0;
  const handoffModel = _config.visionHandoffModel || "umans-kimi-k2.7";
  console.log(`[UMANS] [Session#${sessNum}>${keyName}]-[${resolvedModel}]-vision-handoff: ${imageParts.length} image(s) → ${handoffModel}`);
  const descriptions = await Promise.all(imageParts.map((ip, i) => analyzeImageViaHandoff(ip.dataUri, key, keyName, sessNum, i)));
  for (let i = 0; i < imageParts.length; i++) {
    const { container, index } = imageParts[i];
    const label = imageParts.length > 1 ? `[User pasted image ${i + 1}]\n` : "[User pasted image]\n";
    container[index] = { type: "text", text: label + descriptions[i] };
  }
  return imageParts.length;
}

// --- app.umans.ai account functions ---
function makeAppCookie(sessionToken: string): string {
  return `__Secure-authjs.session-token=${sessionToken}`;
}

let usageCache = { data: null as any, time: 0, ttl: 5 * 60 * 1000 };
let usageHistoryCache = { data: null as any, time: 0, ttl: 5 * 60 * 1000 };
let concurrencyCache = { concurrent: null as number | null, limit: null as number | null, user_id: null as string | null, time: 0, ttl: 5 * 60 * 1000 };

export async function fetchUsage(opts: { force?: boolean } = {}): Promise<any> {
  if (!_config.appSession) {
    await loginToApp();
  }
  if (!opts.force && usageCache.data && Date.now() - usageCache.time < usageCache.ttl) return usageCache.data;
  if (!_config.appSession) return null;
  try {
    const resp = await fetch(`${APP_BASE}/api/usage?context=personal`, {
      headers: { Cookie: makeAppCookie(_config.appSession), Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    usageCache = { data, time: Date.now(), ttl: 5 * 60 * 1000 };
    return data;
  } catch (e: any) {
    if (isDebug()) console.log(`[UMANS] usage fetch failed: ${e.message}`);
    return usageCache.data;
  }
}

export async function loginToApp(email?: string, password?: string): Promise<boolean> {
  if (email && password) {
    _config.email = email;
    _config.password = password;
  }
  if (!_config.email || !_config.password) return false;
  try {
    const csrfResp = await fetch(`${APP_BASE}/api/auth/csrf`, { signal: AbortSignal.timeout(10000) });
    if (!csrfResp.ok) return false;
    const csrfData = await csrfResp.json();
    const csrfToken = csrfData.csrfToken;
    if (!csrfToken) return false;
    const setCookie = csrfResp.headers.get("set-cookie") || "";
    const cookieMatch = setCookie.match(/__Host-authjs\.csrf-token=([^;]+)/);
    const csrfCookie = cookieMatch ? `__Host-authjs.csrf-token=${cookieMatch[1]}` : "";

    const loginResp = await fetch(`${APP_BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrfCookie,
      },
      body: new URLSearchParams({
        csrfToken,
        email: _config.email,
        password: _config.password,
        callbackUrl: `${APP_BASE}/billing`,
        json: "true",
      }).toString(),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    const loginCookies = loginResp.headers.get("set-cookie") || "";
    const sessionMatch = loginCookies.match(/__Secure-authjs\.session-token=([^;]+)/);
    if (sessionMatch) {
      _config.appSession = sessionMatch[1];
      emitLoginState();
      return true;
    }
    return false;
  } catch (e) { return false; }
}

export async function maybeRefreshAccountUserId(): Promise<string | null> {
  if (concurrencyCache.user_id) return concurrencyCache.user_id;
  const res = await fetchConcurrency();
  return res.user_id;
}

export async function fetchKeysFromApp(): Promise<{ name: string; key: string }[]> {
  if (!_config.appSession) return [];
  try {
    const resp = await fetch(`${APP_BASE}/api/keys`, {
      headers: { Cookie: makeAppCookie(_config.appSession), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (Array.isArray(data)) {
      const keys = data.map((k: any) => ({ name: k.name || "Key", key: k.key || "" })).filter((k: any) => k.key.length > 5);
      setUmansKeys(keys);
      return keys;
    }
    if (Array.isArray(data?.keys)) {
      const keys = data.keys.map((k: any) => ({ name: k.name || "Key", key: k.key || "" })).filter((k: any) => k.key.length > 5);
      setUmansKeys(keys);
      return keys;
    }
    return [];
  } catch { return []; }
}

export function logoutApp(): void {
  _config.appSession = "";
  usageCache = { data: null, time: 0, ttl: 5 * 60 * 1000 };
  usageHistoryCache = { data: null, time: 0, ttl: 5 * 60 * 1000 };
  concurrencyCache = { concurrent: null as number | null, limit: null as number | null, user_id: null as string | null, time: 0, ttl: 5 * 60 * 1000 };
  emitLoginState();
}

export function isLoggedIn(): boolean {
  return !!_config.appSession;
}

export function getAccountInfo(): { loggedIn: boolean; email: string; hasPassword: boolean; userId: string | null } {
  return { loggedIn: !!_config.appSession, email: _config.email || "", hasPassword: !!_config.password, userId: concurrencyCache.user_id };
}

async function fetchHistoryRange(from: string, to: string): Promise<{ buckets: { bucket: string; requests: number; tokens_in: number; tokens_out: number; tokens_cached: number }[] } | null> {
  const fromIso = `${from}T00:00:00Z`;
  const toIso = `${to}T23:59:59Z`;
  const url = `${APP_BASE}/api/usage/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&granularity=day`;
  try {
    if (isDebug()) console.log(`[usage-history] GET ${url}`);
    const resp = await fetch(url, {
      headers: { Cookie: makeAppCookie(_config.appSession), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      if (isDebug()) console.log(`[usage-history] upstream ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const buckets = extractUsageBuckets(data);
    if (!buckets) return null;
    return { buckets };
  } catch (e: any) {
    if (isDebug()) console.log(`[usage-history] range failed: ${e.message}`);
    return null;
  }
}

function generateDateStrings(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = new Date(from.slice(0, 10));
  const end = new Date(to.slice(0, 10));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function toContiguousRanges(dates: string[]): [string, string][] {
  if (!dates.length) return [];
  const sorted = [...dates].sort();
  const ranges: [string, string][] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prevDate = new Date(prev);
    prevDate.setDate(prevDate.getDate() + 1);
    if (curr === prevDate.toISOString().slice(0, 10)) {
      prev = curr;
    } else {
      ranges.push([start, prev]);
      start = curr;
      prev = curr;
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

export async function fetchUsageHistory(opts: { force?: boolean } = {}): Promise<any> {
  if (!_config.appSession) {
    await loginToApp();
  }
  if (!opts.force && usageHistoryCache.data && Date.now() - usageHistoryCache.time < usageHistoryCache.ttl) return usageHistoryCache.data;
  if (!_config.appSession) return null;
  try {
    const range = getUsageHistoryDateRange();
    const missing: string[] = [];
    const mergedMap: Record<string, { bucket: string; requests: number; tokens_in: number; tokens_out: number; tokens_cached: number }> = {};
    const allDates = generateDateStrings(range.from, range.to);
    for (const d of allDates) {
      if (d !== range.today) missing.push(d);
      else {
        mergedMap[d] = { bucket: d, requests: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0 };
      }
    }
    let fetchedAny = false;
    if (missing.length > 0) {
      const ranges = toContiguousRanges(missing);
      for (const [rFrom, rTo] of ranges) {
        const data = await fetchHistoryRange(rFrom, rTo);
        if (data?.buckets) {
          fetchedAny = true;
          const returnedDates = new Set<string>();
          for (const raw of data.buckets) {
            const bucket = normalizeUsageBucket(raw);
            if (!bucket) continue;
            mergedMap[bucket.bucket] = bucket;
            returnedDates.add(bucket.bucket);
          }
          // API omits zero-usage days — treat absent dates as zero
          for (const d of generateDateStrings(rFrom, rTo)) {
            if (!returnedDates.has(d)) {
              mergedMap[d] = { bucket: d, requests: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0 };
            }
          }
        }
      }
    }
    const buckets = Object.keys(mergedMap).sort().reverse().map(d => mergedMap[d]);
    const result = { buckets };
    if (fetchedAny || !usageHistoryCache.data) {
      usageHistoryCache = { data: result, time: Date.now(), ttl: 5 * 60 * 1000 };
    }
    return usageHistoryCache.data;
  } catch (e: any) {
    if (isDebug()) console.log(`[UMANS] usage history fetch failed: ${e.message}`);
    return usageHistoryCache.data;
  }
}

export async function fetchConcurrency(): Promise<{ concurrent: number; limit: number | null; user_id: string | null }> {
  const k = _config.keys[0]?.key || "";
  if (!k) return { concurrent: 0, limit: null, user_id: null };
  if (concurrencyCache.concurrent !== null && Date.now() - concurrencyCache.time < concurrencyCache.ttl) {
    return { concurrent: concurrencyCache.concurrent, limit: concurrencyCache.limit, user_id: concurrencyCache.user_id };
  }
  try {
    const resp = await fetch(`${_config.upstreamBaseURL}/usage`, {
      headers: { Authorization: `Bearer ${k}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      agent: UPSTREAM_AGENT as any,
    });
    if (!resp.ok) return { concurrent: 0, limit: null, user_id: null };
    const data = await resp.json() as any;
    const concurrent = data?.usage?.concurrent_sessions ?? 0;
    const limit = data?.limits?.concurrency?.limit ?? null;
    const user_id = data?.user_id ?? null;
    concurrencyCache = { concurrent, limit, user_id, time: Date.now(), ttl: 5 * 60 * 1000 };
    return { concurrent, limit, user_id };
  } catch (e) {
    return concurrencyCache.concurrent !== null
      ? { concurrent: concurrencyCache.concurrent, limit: concurrencyCache.limit, user_id: concurrencyCache.user_id }
      : { concurrent: 0, limit: null, user_id: null };
  }
}

export function getEffectiveConcurrency(): { concurrent: number; limit: number | null; overridden: boolean } {
  const apiLimit = concurrencyCache.limit;
  const apiConcurrent = concurrencyCache.concurrent || 0;
  const override = _config.overrideConcurrency || 0;
  if (override > 0) {
    const effectiveLimit = apiLimit !== null ? Math.min(override, apiLimit) : override;
    return { concurrent: apiConcurrent, limit: effectiveLimit, overridden: true };
  }
  return { concurrent: apiConcurrent, limit: apiLimit, overridden: false };
}

// --- Chat completion proxy with retry/session/caching ---
interface RequestQueueItem {
  resolve: (value: Response) => void;
  reject: (reason?: any) => void;
  payload: any;
  requestedModel: string;
  skipSessionLabel: boolean;
}

let activeRequests = 0;
let requestQueue: RequestQueueItem[] = [];

const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 10;

function processQueue() {
  if (requestQueue.length === 0) return;
  const eff = getEffectiveConcurrency();
  const limit = eff.limit;
  if (limit === null) return;
  while (requestQueue.length > 0 && activeRequests < limit) {
    const item = requestQueue.shift();
    if (!item) continue;
    activeRequests++;
    proxyChatRequest(item.payload, item.requestedModel, item.skipSessionLabel)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => { activeRequests--; processQueue(); });
  }
}

export function queueChatRequest(payload: any, requestedModel: string, skipSessionLabel = false): Promise<Response> {
  return new Promise((resolve, reject) => {
    const eff = getEffectiveConcurrency();
    if (eff.limit !== null && activeRequests >= eff.limit) {
      requestQueue.push({ resolve, reject, payload, requestedModel, skipSessionLabel });
      return;
    }
    activeRequests++;
    proxyChatRequest(payload, requestedModel, skipSessionLabel)
      .then(resolve)
      .catch(reject)
      .finally(() => { activeRequests--; processQueue(); });
  });
}

export async function chatCompletion(modelId: string, messages: any[], tools?: any[], stream = true, extra: Record<string, any> = {}): Promise<Response> {
  const payload: any = { ...extra };
  payload.model = modelId;
  payload.messages = messages;
  payload.stream = stream;
  if (stream === false) delete payload.stream;
  if (tools !== undefined) payload.tools = tools.length ? tools.map(sharedNormalizeTool) : undefined;
  if (payload.tools?.length) {
    // umans upstream is OpenAI-compatible; keep schemas lightweight
    const needNorm = payload.tools.some((t: any) => t.function?.parameters?.$defs || t.function?.parameters?.$definitions || t.function?.parameters?.$ref);
    if (needNorm) normalizeToolSchemas(payload.tools);
  }
  return queueChatRequest(payload, modelId, true);
}

// Native Anthropic Messages API pass-through for UMANS. UMANS upstream natively
// supports /messages, so Anthropic-format requests are forwarded directly without
// bridge translation. Vision handoff + image limit are applied first. The response
// is returned as-is (already Anthropic SSE/JSON). Used by vs/handler + copilot-handler
// /v1/messages when the routed model is UMANS — no anthropic-bridge involved.
export async function anthropicChatCompletion(payload: any): Promise<Response> {
  const pool = ensureKeyPool();
  const requestedModel = (payload?.model || "").trim();
  const { level: thinkingLevel } = parseUmansThinkingTag(requestedModel);
  const resolvedModel = resolveUmansModelId(requestedModel);
  payload.model = resolvedModel;

  // Apply thinking budget from the variant tag if the model supports reasoning.
  const modelInfo = modelInfoMap[resolvedModel] || {};
  const reasoningCaps = modelInfo.capabilities?.reasoning;
  if (reasoningCaps?.supported === true) {
    const effLevel = thinkingLevel || (payload.reasoningEffort ? String(payload.reasoningEffort).toLowerCase() : null);
    if (effLevel && REASONING_LEVEL_BUDGETS[effLevel]) {
      payload.thinking = { type: "enabled", budgetTokens: REASONING_LEVEL_BUDGETS[effLevel] };
    } else if (reasoningCaps.can_disable === false && !payload.thinking) {
      payload.thinking = { type: "enabled" };
    }
  }
  delete payload.reasoningEffort;

  limitImagesInMessages(payload, _config.maxImages);
  let slot = await pool.acquire();
  if (!slot) {
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "no healthy API keys available" } }), { status: 503, headers: { "content-type": "application/json" } });
  }
  await performVisionHandoff(payload, resolvedModel, slot.key, slot.name, ++globalSessionCounter);
  try {
    const result = await anthropicMessages(payload, slot.key);
    const contentType = result.headers["content-type"] || (payload.stream ? "text/event-stream" : "application/json");
    return new Response(result.body as any, {
      status: result.status,
      headers: { "content-type": contentType, "cache-control": "no-cache", "connection": "close" },
    });
  } catch (e: any) {
    pool.markUnhealthy(slot.index, 502);
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: e?.message || "upstream fetch failed" } }), { status: 502, headers: { "content-type": "application/json" } });
  }
}

async function proxyChatRequest(payload: any, requestedModel: string, skipSessionLabel: boolean): Promise<Response> {
  const pool = ensureKeyPool();
  const fingerprint = fingerprintPayload(payload);
  let cachedSession = fingerprint ? touchConversation(fingerprint) : undefined;
  let slot = cachedSession ? await pool.acquire(cachedSession.tokenIndex) : null;
  if (!slot) slot = await pool.acquire();
  if (!slot) {
    return new Response(JSON.stringify({ error: { message: "no healthy API keys available", type: "server_error", code: "no_healthy_keys" } }), { status: 503, headers: { "content-type": "application/json" } });
  }

  let session: { tokenIndex: number; requestCount: number; sessNum: number };
  if (fingerprint) {
    if (!cachedSession) {
      session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
      trackConversationSession(fingerprint, session);
    } else {
      session = cachedSession;
      session.requestCount++;
      session.tokenIndex = slot.index;
      trackConversationSession(fingerprint, session);
    }
  } else {
    session = { tokenIndex: slot.index, requestCount: 1, sessNum: ++globalSessionCounter };
  }

  if (!skipSessionLabel) stampSessionLabel(payload, slot.name, session.sessNum);
  stripReasoningContent(payload);
  limitImagesInMessages(payload, _config.maxImages);

  // Parse a thinking-variant suffix (-lo/-md/-hi/-mx or [MX]) off the model id
  // and resolve the base umans- catalog id. The level maps to a thinking budget.
  const { level: thinkingLevel } = parseUmansThinkingTag(requestedModel);
  const resolvedModel = resolveUmansModelId(requestedModel);
  payload.model = resolvedModel;

  if (payload.tools && payload.tools.some((t: any) => t.function?.parameters?.$defs || t.function?.parameters?.$definitions || t.function?.parameters?.$ref)) {
    normalizeToolSchemas(payload.tools);
  }

  const modelInfo = modelInfoMap[resolvedModel] || {};
  const reasoningCaps = modelInfo.capabilities?.reasoning;
  if (reasoningCaps?.supported === true) {
    // reasoningEffort may be set by vs/copilot handlers from the thinking tag.
    const effLevel = thinkingLevel || (payload.reasoningEffort ? String(payload.reasoningEffort).toLowerCase() : null);
    if (effLevel && REASONING_LEVEL_BUDGETS[effLevel]) {
      (payload as any).thinking = { type: "enabled", budgetTokens: REASONING_LEVEL_BUDGETS[effLevel] };
    } else if (reasoningCaps.can_disable === false) {
      (payload as any).thinking = { type: "enabled" };
    }
  }
  // UMANS upstream uses `thinking`, not OpenAI's `reasoningEffort`.
  delete (payload as any).reasoningEffort;

  // Vision handoff: if the resolved model can't see images natively, delegate
  // image analysis to the handoff model and replace images with descriptions.
  await performVisionHandoff(payload, resolvedModel, slot.key, slot.name, session.sessNum);

  // Response cache (non-streaming only). Checked after handoff so cache hits
  // skip the handoff entirely (matches umans-dash ordering).
  const cacheEnabled = _config.cacheEnabled && !payload.stream;
  let ck: string | null = null;
  if (cacheEnabled) {
    ck = cacheKey(payload, requestedModel);
    const cached = responseCache.get(ck);
    if (cached) {
      let parsed: any = null;
      try { parsed = sanitizeChatCompletionResponse(JSON.parse(cached)); } catch {}
      return new Response(parsed ? JSON.stringify(parsed) : cached, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-cache", "connection": "close" } });
    }
  }

  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
  let _toolsCompressedTried = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const isLast = attempt === MAX_RETRIES;
    try {
      const result = await chatCompletions(payload, slot.key);
      const contentType = result.headers["content-type"] || "";
      if (result.status >= 200 && result.status < 300) {
        const isSse = contentType.includes("text/event-stream");
        // Shell-tool guard: buffer the body so we can sanitize tool_calls before
        // the client sees them. Tool-call streams are short, so buffering is OK.
        if (isSse && hasTools) {
          const rawSse = await readBodyText(result.body);
          const sanitized = sanitizeSseResponse(rawSse);
          return new Response(sanitized, {
            status: result.status,
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "close" },
          });
        }
        if (!isSse) {
          let bodyText = await readBodyText(result.body);
          let parsed: any = null;
          try { parsed = JSON.parse(bodyText); } catch {}
          if (parsed) {
            parsed = sanitizeChatCompletionResponse(parsed);
            if (ck) responseCache.set(ck, JSON.stringify(parsed));
            return new Response(JSON.stringify(parsed), { status: result.status, headers: { "content-type": "application/json", "cache-control": "no-cache", "connection": "close" } });
          }
          if (ck) responseCache.set(ck, bodyText);
          return new Response(bodyText, { status: result.status, headers: { "content-type": contentType || "application/json", "cache-control": "no-cache", "connection": "close" } });
        }
        return new Response(result.body as any, {
          status: result.status,
          headers: {
            "content-type": contentType || "application/json",
            "cache-control": result.headers["cache-control"] || "no-cache",
            "connection": "close",
          },
        });
      }
      const errorText = await readBodyText(result.body);
      // UMANS rejects many VS tool schemas with 400; log the upstream error so
      // we can diagnose which schema field is rejected, then retry with
      // aggressively compressed schemas first (preserves tool calling), and
      // only fall back to dropping tools entirely as a last resort.
      if (result.status === 400 && payload.tools?.length) {
        console.log(`[UMANS] 400 with ${payload.tools.length} tool(s): ${errorText.slice(0, 400)}`);
        if (!_toolsCompressedTried) {
          _toolsCompressedTried = true;
          payload.tools = compressToolDefinitions(payload.tools);
          continue;
        }
        console.log(`[UMANS] 400 persists after compress, retrying without tools`);
        payload.tools = undefined;
        continue;
      }
      if (result.status === 500 || result.status === 503) {
        pool.markUnhealthy(slot.index, result.status);
        if (isLast) {
          return new Response(JSON.stringify({ error: { message: errorText, type: "upstream_error", code: String(result.status) } }), { status: result.status, headers: { "content-type": "application/json" } });
        }
        const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (result.status >= 500) pool.markUnhealthy(slot.index, result.status);
      return new Response(JSON.stringify({ error: { message: errorText, type: "upstream_error", code: String(result.status) } }), { status: result.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      pool.markUnhealthy(slot.index, 502);
      if (isLast) {
        return new Response(JSON.stringify({ error: { message: e?.message || "network error", type: "server_error" } }), { status: 502, headers: { "content-type": "application/json" } });
      }
      const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return new Response(JSON.stringify({ error: { message: "max retries exceeded", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json" } });
}

async function readBodyText(body: any): Promise<string> {
  if (!body) return "";
  if (typeof body.pipe === "function") {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      body.on("data", (c: Buffer) => chunks.push(c));
      body.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      body.on("error", reject);
    });
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
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
  return "";
}
