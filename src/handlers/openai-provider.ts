import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDebug } from "../split-console.ts";
import { getProjectRoot } from "../shared.ts";
import { openAIChatCompletion, injectCachedReasoning, storeReasoning } from "./openai-client.ts";
import type { OpenAIChatOptions } from "./openai-client.ts";
export {
  getModelCtx,
  getModelDisplayName,
  getModelFamily,
  modelHasVision,
  loadDisplayNameOverrides,
  setDisplayNameOverride,
  getDisplayNameOverride,
  initModelCtxMap,
  storeReasoning,
  injectCachedReasoning,
} from "./openai-client.ts";

// ── Key Hash Detection ──
function keyHash(): string {
  const all: string[] = [];
  const env = typeof process !== "undefined" ? process.env : {};
  if (env.OPENCODE_API_KEY) all.push(env.OPENCODE_API_KEY);
  if (env.OPENCODE_API_KEYS) {
    try { all.push(...JSON.parse(env.OPENCODE_API_KEYS)); } catch {}
  }
  if (keys.length) all.push(...keys);
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
export function checkKeyChanged(): boolean {
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

// ── Session Tracking ──

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

export function detectSessionSignal(messages: any[]): { sessNum: number; keyIdx: number; keyLabel: string; sessionLabel: string } | null {
  const fingerprint = fingerprintPayload(messages);
  if (!fingerprint) return null;

  loadKeys();

  const entry = conversationMap.get(fingerprint);
  if (entry !== undefined) {
    entry.requestCount++;
    const label = keys[entry.keyIdx] ? `Key${entry.keyIdx + 1}` : `Key${entry.keyIdx + 1}`;
    const sessionLabel = `${label}|sess${entry.sessNum}`;
    return { sessNum: entry.sessNum, keyIdx: entry.keyIdx, keyLabel: label, sessionLabel };
  }

  let keyIdx = 0;
  if (keys.length > 1) {
    const idx = Math.floor(Math.random() * keys.length);
    keyIdx = idx;
  }
  const newEntry = { keyIdx, requestCount: 1, sessNum: ++globalSessionCounter };
  conversationMap.set(fingerprint, newEntry);

  const keyLabel = `Key${keyIdx + 1}`;
  const sessionLabel = `${keyLabel}|sess${newEntry.sessNum}`;

  return { sessNum: newEntry.sessNum, keyIdx, keyLabel, sessionLabel };
}

function getOpenRouterApiKeyLive(): string {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      return c.openrouterKey || "";
    }
  } catch {}
  return "";
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

let keys: string[] = [];
let balancer: ApiBalancer | null = null;
const key429Count = new Map<string, number>();

function tryLoadEnvFile() {
  try {
    const p = path.join(getProjectRoot(), ".config", ".env");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*(OPENCODE_API_KEYS?|OPENCODE_SESSION)\s*=\s*(.+)/);
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

export function loadKeys() {
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

import { chatCompletion as codestralChat } from "./codestral-client.ts";
import { chatCompletion as umansChat } from "./umans-client.ts";

export function getModelProviderTag(modelId: string): string {
  if (modelId.startsWith("umans-")) return "umans";
  if (modelId.startsWith("freebuff/")) return "freebuff";
  if (modelId.startsWith("openrouter/")) return "openrouter";
  if (modelId.startsWith("agnes")) return "agnes";
  if (modelId.startsWith("codestral")) return "codestral";
  if (modelId.startsWith("bitnet/") || modelId === "bitnet-demo") return "bitnet";
  if (modelId.toLowerCase().includes("deepseek")) return "deepseek";
  if (modelId.endsWith("-free") || modelId === "big-pickle" || modelId === "nemotron-3-super-free" || modelId === "ring-2.6-1t-free") return "zen";
  return "go";
}

// ── Per-Provider Model Caching ──

function ensureCacheDir(): string {
  const d = path.join(getProjectRoot(), ".cache");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

type Provider = "go" | "zen" | "openrouter";

function modelDiskPath(provider: Provider): string {
  return path.join(ensureCacheDir(), `models-${provider}.json`);
}

function openRouterKeyHash(): string {
  const key = getOpenRouterApiKeyLive();
  if (!key) return "no-openrouter-key";
  return crypto.createHash("sha256").update(key).digest("hex");
}

function loadProviderModels(provider: Provider): string[] | null {
  try {
    const p = modelDiskPath(provider);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const h = provider === "openrouter" ? openRouterKeyHash() : keyHash();
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
    const h = provider === "openrouter" ? openRouterKeyHash() : keyHash();
    fs.writeFileSync(modelDiskPath(provider), JSON.stringify({ _modelIds: ids, _keyHash: h }));
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
      return (data?.data || []).map((m: any) => typeof m === "string" ? m : m.id || "").filter((id: string) => id.length > 0 && !id.toLowerCase().includes("owl"));
    }
    if (isDebug()) console.log(`\n[MODEL CACHE:GO] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[MODEL CACHE:GO] fetch error: ${e.message}`);
  }
  return [];
}

// ── Per-provider model ID caches ──
let _cachedGoIds: string[] | null = null;
let _cachedOpenRouterIds: string[] | null = null;
let _providersInitialized = false;

async function fetchOpenRouterModels(): Promise<string[]> {
  // Disabled for now.
  return [];
}

async function initProviderModels(provider: Provider, goKey?: string): Promise<string[]> {
  const diskIds = loadProviderModels(provider);
  if (diskIds && diskIds.length > 0) {
    const filtered = provider === "go" ? diskIds.filter(id => !id.toLowerCase().includes("owl")) : diskIds;
    if (filtered.length !== diskIds.length && isDebug()) console.log(`\n[MODEL CACHE:GO] filtered ${diskIds.length - filtered.length} non-go models from disk`);
    if (isDebug()) console.log(`\n[MODEL CACHE:${provider.toUpperCase()}] loaded ${filtered.length} from disk`);
    return filtered;
  }

  let fetched: string[] = [];
  if (provider === "go") {
    fetched = await fetchGoModels(goKey || "");
  } else if (provider === "openrouter") {
    fetched = await fetchOpenRouterModels();
  }

  if (fetched.length > 0) {
    saveProviderModels(provider, fetched);
  }
  return fetched;
}

export async function initModels(): Promise<string[]> {
  if (_providersInitialized && _cachedGoIds && _cachedGoIds.length > 0) {
    return [..._cachedGoIds, ...(_cachedOpenRouterIds || [])];
  }

  loadDisplayNameOverrides();
  checkKeyChanged();

  const env = typeof process !== "undefined" ? process.env : {};
  let goKey = "";
  if (env.OPENCODE_API_KEYS) {
    try { goKey = JSON.parse(env.OPENCODE_API_KEYS).find((k: string) => k.length > 5) || ""; } catch {}
  } else if (env.OPENCODE_API_KEY) {
    goKey = env.OPENCODE_API_KEY;
  }
  if (!goKey && keys.length > 0) goKey = keys[0];

  const [goIds, openRouterIds] = await Promise.all([
    initProviderModels("go", goKey),
    initProviderModels("openrouter"),
    initModelCtxMap(),
  ] as any);

  _cachedGoIds = goIds || [];
  _cachedOpenRouterIds = openRouterIds || [];
  _providersInitialized = true;

  const allIds = [..._cachedGoIds, ..._cachedOpenRouterIds];
  if (isDebug()) console.log(`\n[MODEL CACHE] init complete: ${allIds.length} models (${_cachedGoIds.length} go + ${_cachedOpenRouterIds.length} openrouter)`);
  return allIds;
}

export function getModelIds(): string[] {
  if (!_providersInitialized) return [];
  return [...(_cachedGoIds || []), ...(_cachedOpenRouterIds || [])];
}

export function getProviderModelIds(provider: Provider): string[] {
  if (provider === "go") return _cachedGoIds || [];
  if (provider === "openrouter") return _cachedOpenRouterIds || [];
  return [];
}

function getModelTier(modelId: string): "go" | "free" | "openrouter" {
  const l = modelId.toLowerCase();
  if (l.startsWith("openrouter/")) return "openrouter";
  if (l.endsWith("-free") || l === "big-pickle" || l === "nemotron-3-super-free" || l === "ring-2.6-1t-free") return "free";
  return "go";
}

export async function chatCompletion(modelId: string, messages: any[], tools?: any[], stream = true, extra: Record<string, any> = {}, pinnedKeyIdx?: number, sessionLabel?: string): Promise<Response> {
  const tier = getModelTier(modelId);

  if (tier === "free") {
    throw new Error("Free tier is throttled. Try again later.");
  }

  if (tier === "openrouter") {
    const openrouterKey = getOpenRouterApiKeyLive();
    if (!openrouterKey) throw new Error("No OpenRouter API key configured.");
    return openAIChatCompletion({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      modelId: modelId.replace(/^openrouter\//, ""),
      messages,
      tools,
      stream,
      extra,
    });
  }

  const key = withKey(pinnedKeyIdx);
  let usedKey = key;

  const headers: Record<string, string> = {};
  if (sessionLabel) headers["x-session"] = sessionLabel;

  let resp: Response | null = null;
  try {
    resp = await openAIChatCompletion({
      baseUrl: CONFIG.baseUrl,
      apiKey: key,
      modelId,
      messages,
      tools,
      stream,
      extra,
      headers,
    });
  } catch (e: any) {
    throw e;
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const statusStr = `${resp.status}`;
    const modelInfo = `${modelId} (via ${tier})`;
    const service = CONFIG.baseUrl;
    const urlShort = `${service}/chat/completions`;
    const toolCount = tools?.length || 0;
    const msgCount = messages?.length || 0;
    const firstMsg = messages?.find((m: any) => m.role === "user");
    let umsg = "(none)";
    try { umsg = typeof firstMsg?.content === "string" ? firstMsg.content.slice(0, 100) : JSON.stringify(firstMsg?.content).slice(0, 100); } catch {}
    const bd = txt ? txt.slice(0, 500) : "(empty)";
    const hx = Buffer.from(txt || "").slice(0, 100).toString("hex");
    console.log(`[UPSTREAM] ${statusStr} ${modelInfo} @ ${urlShort} | url=${service}/chat/completions | msgs=${msgCount} tools=${toolCount} | msg="${umsg}" | body="${bd}" | hex="${hx}"`);

    if (resp.status === 429 && usedKey) {
      const resetSec = parseRetryAfter(resp);
      if (balancer) balancer.mark429(usedKey, resetSec);
      if (balancer && !balancer.hasAvailable()) {
        throw new Error("All API keys are rate-limited. Try again later.");
      }
      const newKey = withKey();
      if (newKey) {
        usedKey = newKey;
        const retryResp = await openAIChatCompletion({
          baseUrl: CONFIG.baseUrl, apiKey: newKey, modelId, messages, tools, stream, extra, headers,
        });
        if (retryResp.ok) return retryResp;
        const retryTxt = await retryResp.text().catch(() => "");
        console.log(`[UPSTREAM] retry failed: ${retryResp.status} body: ${retryTxt.slice(0, 500)}`);
        throw new Error(`API ${retryResp.status}: ${retryTxt}`);
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    if (resp.status === 402 && usedKey && balancer) {
      balancer.mark402(usedKey, txt);
      if (!balancer.hasAvailable()) {
        throw new Error("All API keys have reached their usage limits. Try again later or use free models.");
      }
      const newKey = withKey();
      if (newKey) {
        usedKey = newKey;
        const retryResp = await openAIChatCompletion({
          baseUrl: CONFIG.baseUrl, apiKey: newKey, modelId, messages, tools, stream, extra, headers,
        });
        if (retryResp.ok) return retryResp;
        const retryTxt = await retryResp.text().catch(() => "");
        console.log(`[UPSTREAM] retry failed: ${retryResp.status} body: ${retryTxt.slice(0, 500)}`);
        throw new Error(`API ${retryResp.status}: ${retryTxt}`);
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    if (resp.status === 401 && usedKey && balancer) {
      balancer.mark401(usedKey);
      const newKey = withKey();
      if (newKey) {
        usedKey = newKey;
        const retryResp = await openAIChatCompletion({
          baseUrl: CONFIG.baseUrl, apiKey: newKey, modelId, messages, tools, stream, extra, headers,
        });
        if (retryResp.ok) return retryResp;
      }
      throw new Error(`API ${resp.status}: ${txt}`);
    }
    throw new Error(`API ${resp.status}: ${txt}`);
  }

  if (usedKey) balancer?.markSuccess(usedKey);
  return resp;
}

export function setKeys(newKeys: string[]) {
  const filtered = newKeys.filter(k => k && k.length > 5);
  const changed = keys.length !== filtered.length || keys.some((k, i) => k !== filtered[i]);
  keys = filtered;
  if (keys.length > 0 && (!balancer || changed)) {
    const savedState = loadKeyState();
    balancer = new ApiBalancer(keys, savedState);
  }
  if (changed && filtered.length > 0) {
    _providersInitialized = false;
    _cachedGoIds = null;
    initModels().catch(() => {});
  }
}
