// UMANS client — account, key pool, usage, and chat completion for api.code.umans.ai
import * as crypto from "node:crypto";
import * as https from "node:https";
import { isDebug } from "../split-console.ts";

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
};

export function setUmansConfig(cfg: Partial<UmansConfig>) {
  _config = { ..._config, ...cfg };
  if (_keyPool) {
    const filtered = (_config.keys || []).filter(k => k.key && k.key.length > 5);
    _keyPool = new KeyPool(filtered);
  }
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
  if (!Array.isArray(msgs)) return null;
  const idx = msgs.findIndex((m: any) => m.role === "user" && !TITLE_PROMPT_RE.test(msgText(m)));
  const raw = msgText(msgs[idx >= 0 ? idx : msgs.findIndex((m: any) => m.role === "user")]);
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
  return modelDisplayNameMap[id] || id.replace(/^umans-/i, "");
}

export function getEnabledModels(): string[] {
  return _config.enabledModels || [];
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

export async function fetchUsageHistory(opts: { force?: boolean } = {}): Promise<any> {
  if (!_config.appSession) {
    await loginToApp();
  }
  if (!opts.force && usageHistoryCache.data && Date.now() - usageHistoryCache.time < usageHistoryCache.ttl) return usageHistoryCache.data;
  if (!_config.appSession) return null;
  try {
    const now = new Date();
    const to = now.toISOString();
    const from = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
    const url = `${APP_BASE}/api/usage/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=day`;
    const resp = await fetch(url, {
      headers: { Cookie: makeAppCookie(_config.appSession), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    usageHistoryCache = { data, time: Date.now(), ttl: 5 * 60 * 1000 };
    return data;
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

  const resolvedModel = requestedModel.startsWith("umans-") ? requestedModel : (() => {
    const prefixed = "umans-" + requestedModel;
    if (_config.enabledModels.includes(prefixed)) return prefixed;
    if (_config.enabledModels.includes(requestedModel)) return requestedModel;
    return requestedModel;
  })();
  payload.model = resolvedModel;

  if (payload.tools && payload.tools.some((t: any) => t.function?.parameters?.$defs || t.function?.parameters?.$definitions || t.function?.parameters?.$ref)) {
    normalizeToolSchemas(payload.tools);
  }

  const modelInfo = modelInfoMap[resolvedModel] || {};
  const reasoningCaps = modelInfo.capabilities?.reasoning;
  if (reasoningCaps?.supported === true && reasoningCaps.can_disable === false) {
    (payload as any).thinking = { type: "enabled" };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const isLast = attempt === MAX_RETRIES;
    try {
      const result = await chatCompletions(payload, slot.key);
      const contentType = result.headers["content-type"] || "";
      if (result.status >= 200 && result.status < 300) {
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
