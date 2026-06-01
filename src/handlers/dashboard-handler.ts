// Dashboard handler — serves web dashboard HTML + JSON API endpoints
// Always intercepted (even in proxy mode) at /dashboard and /api/* paths
// Status/data pushes to WebSocket clients on change only (delta-based)

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { HandlerInput, HandlerResult, jsonResponse, getProjectRoot, getMode, setMode } from "../shared.ts";
import { getModelIds, getModelFamily, getModelDisplayName } from "./opencode-client.ts";
import { getTps, restoreTerminal } from "../split-console.ts";
import { getWorkspaceDataForKey, KeyWorkspaceData } from "../opencode-workspace.ts";

// ── WebSocket Server (dedicated http.Server — handles upgrades natively) ──
export const WS_PORT = parseInt(process.env.gc2xy_WS_PORT || "3441");
let _wss: WebSocketServer | null = null;
let _wsClients = new Set<WebSocket>();

export function createWsServer() {
  if (_wss) return _wss;
  const srv = createHttpServer((_req, res) => {
    res.writeHead(400);
    res.end("WS only");
  });
  _wss = new WebSocketServer({ server: srv, path: "/ws" });
  _wss.on("connection", (ws) => {
    _wsClients.add(ws);
    pushStatusToWs(ws);
    ws.on("close", () => _wsClients.delete(ws));
    ws.on("message", (raw) => {
      try { const msg = JSON.parse(raw.toString()); handleWsMessage(ws, msg).catch(() => {}); } catch {}
    });
    ws.on("error", () => _wsClients.delete(ws));
  });
  srv.listen(WS_PORT, "127.0.0.1");
  return _wss;
}

// ── Snapshot / Diff System ──
let _lastSnapshot: Record<string, any> = {};

function takeSnapshot(): Record<string, any> {
  const provider = _config?.provider || defaultProvider();
  const models = provider === "zen" ? getZenModels() : getOcModels();
  const zenKeys = _keys.filter(k => k.provider === "zen");
  const ocKeys = _keys.filter(k => k.provider === "opencode");
  return {
    status: {
      mode: getMode().toUpperCase(),
      requests: _requestCount,
      tps: getTps(),
      provider,
      hasValidKey: _hasValidKey,
      modelCount: models.length,
      enabledModelCount: models.filter((m: any) => m.enabled !== false).length,
    },
    models: models.map(m => ({ id: m.id, name: m.name, family: m.family, enabled: m.enabled !== false, free: !!m.free, locked: !!m.locked, provider: m.provider })),
    keys: {
      zen: zenKeys.map(k => ({ name: k.name, token: k.token, session: k.session ? k.session.slice(0, 8) + "..." : "" })),
      opencode: ocKeys.map(k => ({ name: k.name, token: k.token, session: !!k.session, valid: _validKeys.has(k.token) })),
    },
    health: { status: _hasValidKey ? "ok" : "degraded", runtime: getRuntime(), platform: process.platform },
  };
}

function diffSnapshots(oldSnap: Record<string, any>, newSnap: Record<string, any>): Record<string, any> {
  const changes: Record<string, any> = {};
  for (const key of Object.keys(newSnap)) {
    const o = JSON.stringify(oldSnap[key]);
    const n = JSON.stringify(newSnap[key]);
    if (o !== n) changes[key] = newSnap[key];
  }
  return changes;
}

function pushStatusToWs(ws?: WebSocket) {
  const newSnap = takeSnapshot();
  const clients = ws ? [ws] : [..._wsClients];
  if (ws) {
    ws.send(JSON.stringify({ type: "snapshot", data: newSnap }));
  } else {
    const changes = diffSnapshots(_lastSnapshot, newSnap);
    _lastSnapshot = newSnap;
    if (Object.keys(changes).length === 0) return;
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "patch", data: changes }));
      }
    }
  }
}

// Push every 2s to check for changes (throttled delta detection)
let _pushTimer: ReturnType<typeof setInterval> | null = null;
export function startWsPushLoop() { if (!_pushTimer) _pushTimer = setInterval(() => pushStatusToWs(), 2000); }
export function stopWsPushLoop() { if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; } }

async function handleWsMessage(ws: WebSocket, msg: any) {
  const { action, payload } = msg;
  switch (action) {
    case "setProvider": {
      if (payload?.provider) { _config = { ...(_config || {}), provider: payload.provider }; saveZenConfig(); }
      pushStatusToWs();
      break;
    }
    case "setMode": {
      if (payload?.mode) setMode(payload.mode.toLowerCase());
      pushStatusToWs();
      break;
    }
    case "toggleModel": {
      if (payload?.modelId && payload?.enabled !== undefined) _modelStates[payload.modelId] = payload.enabled;
      pushStatusToWs();
      break;
    }
    case "batchModelStates": {
      if (payload?.states) _modelStates = { ..._modelStates, ...payload.states };
      pushStatusToWs();
      break;
    }
    case "addKey": {
      const prov = payload?.provider || _config?.provider || defaultProvider();
      _keys.push({ name: payload?.name || `Key ${_keys.length + 1}`, token: payload?.token || "", session: payload?.session || "", provider: prov });
      saveZenConfig();
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "updateKey": {
      if (typeof payload?.index === "number" && _keys[payload.index]) {
        if (payload.name !== undefined) _keys[payload.index].name = payload.name;
        if (payload.token !== undefined) _keys[payload.index].token = payload.token;
        if (payload.session !== undefined) _keys[payload.index].session = payload.session;
        saveZenConfig();
      }
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "deleteKey": {
      if (typeof payload?.index === "number" && _keys[payload.index]) { _keys.splice(payload.index, 1); saveZenConfig(); }
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "setZenSession": {
      if (payload?.sessionCookie) {
        _zenSessionCookie = payload.sessionCookie;
        for (const k of _keys) { if (k.provider === "zen" && !k.session) k.session = payload.sessionCookie; }
        saveZenConfig();
      }
      pushStatusToWs();
      break;
    }
    case "clearZenSession": {
      _zenSessionCookie = "";
      saveZenConfig();
      pushStatusToWs();
      break;
    }
    case "setOcSession": {
      if (payload?.sessionCookie) {
        _ocSessionCookie = payload.sessionCookie;
        for (const k of _keys) { if (k.provider === "opencode" && !k.session) k.session = payload.sessionCookie; }
        saveZenConfig();
        _workspaceCache = [];
      }
      pushStatusToWs();
      break;
    }
    case "clearOcSession": {
      _ocSessionCookie = "";
      saveZenConfig();
      _workspaceCache = [];
      pushStatusToWs();
      break;
    }
    case "validateKeys": {
      await validateOpencodeKeys();
      pushStatusToWs();
      break;
    }
    case "getZenStats": {
      try {
        const stats = await fetchZenithStats();
        ws.send(JSON.stringify({ type: "zenStats", data: stats }));
      } catch { ws.send(JSON.stringify({ type: "zenStats", data: { loggedIn: false } })); }
      break;
    }
    case "getWorkspaceUsage": {
      try {
        const wsData = await getWorkspaceUsage();
        ws.send(JSON.stringify({ type: "workspaceUsage", data: wsData }));
      } catch { ws.send(JSON.stringify({ type: "workspaceUsage", data: { cached: false, data: [] } })); }
      break;
    }
    case "getBingBg": {
      try {
        const resp = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1", { headers: { "User-Agent": "gc2xy/3.0" } });
        const d = await resp.json();
        const url = d?.images?.[0]?.url;
        ws.send(JSON.stringify({ type: "bingBg", data: url ? { url: "https://www.bing.com" + url } : { error: "not found" } }));
      } catch {}
      break;
    }
    case "restart": {
      ws.send(JSON.stringify({ type: "restarting", data: { success: true } }));
      setTimeout(() => {
        try { restoreTerminal(); } catch {}
        try { unlinkSync(join(getProjectRoot(), ".cache", "proxy-host-pid")); } catch {}
        process.exit(42);
      }, 500);
      break;
    }
    case "saveConfig": {
      if (payload) {
        const { keys: _, ...safeBody } = payload;
        _dashboardConfig = { ..._dashboardConfig, ...safeBody };
        if (payload.mode) setMode(payload.mode.toLowerCase());
        if (payload.models) for (const m of payload.models) _modelStates[m.id] = m.enabled !== false;
        if (payload.provider) { _config = { ...(_config || {}), provider: payload.provider }; saveZenConfig(); }
        validateOpencodeKeys().catch(() => {});
      }
      pushStatusToWs();
      break;
    }
  }
}

// Load .env file so env vars are available to top-level code
try {
  const envPath = join(getProjectRoot(), ".config", ".env");
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+)/);
      if (m) {
        let val = m[2].replace(/^["']|["']$/g, "").trim();
        if (val && !process.env[m[1]]) process.env[m[1]] = val;
      }
    }
  }
} catch (e) {}

let _requestCount = 0;
let _config: any = {};

let _modelStates: Record<string, boolean> = {};
let _validKeys = new Set<string>();
let _hasValidKey = false;
let _keyBalances: Record<string, any> = {};

// Unified keys — single source of truth for all providers
let _keys: { name: string; token: string; session: string; provider: string }[] = [];
let _zenSessionCookie = "";
let _zenEmail = "";
let _zenPassword = "";
let _ocSessionCookie = "";
let _zenModels: string[] = [];
let _zenModelsLoaded = false;
let _dashboardCache: any = {};
let _dashboardCacheTime = 0;
const DASHBOARD_CACHE_TTL = 30000;

let _dashboardConfig: Record<string, any> = {
  mode: "mock",
  httpPort: 80,
  iisProxy: false,
  keys: [],
  models: [],
};

// ZEN model fallback when API fetch fails
const ZENITH_FALLBACK = [
  "deepseek-v4-pro", "deepseek-v4-flash-full", "deepseek-v4-flash-precision", "deepseek-v4-pro-full", "deepseek-v4-pro-precision", "deepseek-v3.2",
  "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.5-pro-full", "mimo-v2.5-pro-precision", "mimo-v2-pro", "mimo-v2-omni",
  "qwen-3.5-397b-a17b", "qwen-3.5-9b", "qwen-3.6-27b", "qwen-3.6-27b-full", "qwen-3.6-plus",
  "gemma-4-31b", "gemma-4-31b-it-precision",
  "minimax-m2.5", "minimax-m2.5-speed", "minimax-m2.7", "minimax-m2.7-speed",
  "kimi-k2.5", "kimi-k2.6", "kimi-k2.6-precision", "kimi-k2.6-smart",
  "step-3.5-flash", "step-3.5-flash-2603",
  "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1", "glm-5.1-full", "glm-5.1-precision",
  "grok-imagine-image",
];

// Load keys from env into unified _keys array
try {
  const envKeys = process.env.OPENCODE_API_KEYS;
  if (envKeys) {
    const parsed = JSON.parse(envKeys);
    if (Array.isArray(parsed)) {
      parsed.filter((k: string) => k.length > 5).forEach((k: string) => {
        _keys.push({ name: `Key ${k.slice(0, 8)}...`, token: k, session: "", provider: "opencode" });
      });
    }
  } else if (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.length > 5) {
    _keys.push({ name: "Primary Key", token: process.env.OPENCODE_API_KEY, session: "", provider: "opencode" });
  }
  const zk = process.env.ZENITH_API_KEY;
  if (zk && zk.length > 5) {
    _keys.push({ name: "ZEN Key", token: zk, session: "", provider: "zen" });
  }
  const zs = process.env.ZENITH_SESSION;
  if (zs && zs.length > 5) {
    _zenSessionCookie = zs;
  }
  const os = process.env.OPENCODE_SESSION;
  if (os && os.length > 5) {
    _ocSessionCookie = os;
  }
} catch (e) {}

// Load persisted keys from .config/config.json on startup
function tryParseJwtExp(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return 0;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    return payload.exp || 0;
  } catch { return 0; }
}

loadZenConfig();
fetchZenModels();

function defaultProvider(): string {
  return _keys.some(k => k.provider === "zen") ? "zen" : "opencode";
}

function loadZenConfig() {
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf-8"));
      if (c.ZENITH_SESSION) {
        const exp = tryParseJwtExp(c.ZENITH_SESSION);
        const now = Math.floor(Date.now() / 1000);
        if (exp > now && !_zenSessionCookie) _zenSessionCookie = c.ZENITH_SESSION;
      }
      if (c.OPENCODE_SESSION) _ocSessionCookie = c.OPENCODE_SESSION;
      if (c.ZENITH_EMAIL) _zenEmail = c.ZENITH_EMAIL;
      if (c.ZENITH_PASSWORD) _zenPassword = c.ZENITH_PASSWORD;
      if (c.TOKENS && Array.isArray(c.TOKENS)) {
        for (const t of c.TOKENS) {
          if (t.token && !_keys.find(x => x.token === t.token)) {
            const isZen = t.token.startsWith("sk-zenith-");
            _keys.push({ name: t.name || "Key", token: t.token, session: t.session || "", provider: isZen ? "zen" : (t.provider || "opencode") });
            if (isZen && t.session) {
              const exp = tryParseJwtExp(t.session);
              if (exp && exp > Math.floor(Date.now() / 1000) && (!_zenSessionCookie || exp > tryParseJwtExp(_zenSessionCookie) || 0)) {
                _zenSessionCookie = t.session;
              }
            }
          }
        }
      }
      if (c.provider) {
        _config = { ...(_config || {}), provider: c.provider };
      }
    }
  } catch {}
}

function saveZenConfig() {
  try {
    const dir = join(getProjectRoot(), ".config");
    if (!existsSync(dir)) try { writeFileSync(join(dir, ".gitkeep"), ""); } catch {}
    const p = join(dir, "config.json");
    const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
    existing.ZENITH_SESSION = _zenSessionCookie;
    existing.OPENCODE_SESSION = _ocSessionCookie;
    existing.ZENITH_EMAIL = _zenEmail;
    existing.ZENITH_PASSWORD = _zenPassword;
    existing.TOKENS = _keys;
    if (_config?.provider) existing.provider = _config.provider;
    writeFileSync(p, JSON.stringify(existing, null, 2));
  } catch {}
}

async function validateOpencodeKeys(): Promise<void> {
  const keys = _keys.filter(k => k.provider === "opencode");
  _hasValidKey = false;
  _validKeys.clear();
  if (keys.length === 0) return;
  let anyValid = false;
  for (const k of keys) {
    try {
      const resp = await fetch("https://opencode.ai/zen/go/v1/models", {
        headers: { Authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        _validKeys.add(k.token); anyValid = true;
        try {
          const balResp = await fetch("https://opencode.ai/zen/go/v1/dashboard/billing", {
            headers: { Authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(3000),
          });
          if (balResp.ok) _keyBalances[k.token] = await balResp.json();
        } catch {}
      } else _validKeys.delete(k.token);
    } catch { _validKeys.delete(k.token); }
  }
  _hasValidKey = anyValid;
}

async function tryZenithLogin(): Promise<void> {
  try {
    const resp = await fetch("https://api.zenllm.org/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: _zenEmail, password: _zenPassword }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.session) { _zenSessionCookie = data.session; saveZenConfig(); }
    }
  } catch {}
}

async function fetchZenithStats(): Promise<any> {
  if (Date.now() - _dashboardCacheTime < DASHBOARD_CACHE_TTL && _dashboardCache.loggedIn) {
    return { ..._dashboardCache };
  }
  const zenKeys = _keys.filter(k => k.provider === "zen");
  const seen = new Set<string>();
  const sessions: string[] = [];
  if (_zenSessionCookie) {
    for (const k of zenKeys) { if (!k.session) k.session = _zenSessionCookie; }
  }
  for (const k of zenKeys) { if (k.session && !seen.has(k.session)) { sessions.push(k.session); seen.add(k.session); } }
  if (sessions.length === 0 && _zenSessionCookie) sessions.push(_zenSessionCookie);
  if (sessions.length === 0 && _zenEmail && _zenPassword) {
    await tryZenithLogin();
    if (_zenSessionCookie) sessions.push(_zenSessionCookie);
  }
  let totalRequests = 0, totalTokens = 0, totalCost = 0, totalBalance = 0, anyLoggedIn = false;
  // Try session cookie auth first
  for (const session of sessions) {
    try {
      const resp = await fetch("https://api.zenllm.org/api/dashboard", {
        headers: { cookie: `zs=${session}`, "x-requested-with": "XMLHttpRequest" },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status === 401) continue;
      anyLoggedIn = true;
      const data = await resp.json();
      if (data?.stats?.totals) {
        const totals = data.stats.totals;
        totalRequests += totals.requests || 0;
        totalTokens += (totals.prompt || 0) + (totals.completion || 0) + (totals.cached || 0);
        totalCost += data.stats.totalCostUsd || 0;
        totalBalance += data.stats.balanceUsd || 0;
      }
    } catch {}
  }
  // If no session worked, try Bearer token auth with a ZEN API key
  if (!anyLoggedIn) {
    for (const k of zenKeys) {
      try {
        const resp = await fetch("https://api.zenllm.org/api/dashboard", {
          headers: { authorization: `Bearer ${k.token}`, "x-requested-with": "XMLHttpRequest" },
          signal: AbortSignal.timeout(8000),
        });
        if (resp.status === 401) continue;
        anyLoggedIn = true;
        const data = await resp.json();
        if (data?.stats?.totals) {
          const totals = data.stats.totals;
          totalRequests += totals.requests || 0;
          totalTokens += (totals.prompt || 0) + (totals.completion || 0) + (totals.cached || 0);
          totalCost += data.stats.totalCostUsd || 0;
          totalBalance += data.stats.balanceUsd || 0;
        }
        break;
      } catch {}
    }
  }
  _dashboardCache = { requests: totalRequests, tokens: totalTokens, cost: totalCost, balance: totalBalance, loggedIn: anyLoggedIn, keysCount: zenKeys.length };
  _dashboardCacheTime = Date.now();
  return { ..._dashboardCache };
}

function getDashboardHtml(): string {
  const projectRoot = getProjectRoot();
  const htmlPath = join(projectRoot, "dashboard.html");
  if (existsSync(htmlPath)) return readFileSync(htmlPath, "utf-8");
  return "<html><body><h1>Dashboard not found</h1></body></html>";
}

function getRuntime(): string {
  return typeof Bun !== "undefined" ? "Bun " + (Bun?.version || "") : "Node.js " + process.version;
}

function toSmallCaps(s: string): string {
  const sc: Record<string, string> = {
    a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ғ", g: "ɢ", h: "ʜ", i: "ɪ",
    j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
    s: "s", t: "ᴛ", u: "ᴜ", v: "v", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  };
  return s.split("").map(c => sc[c.toLowerCase()] || c).join("");
}

function formatModelName(id: string): string {
  const parts = getModelDisplayName(id.includes("/") ? id.split("/").pop() || id : id);
  const l = id.toLowerCase();
  const hasThinking = l.includes("deepseek-v4") || (l.includes("mimo") && !l.includes("glm") && !l.includes("kimi") && !l.includes("minimax") && !l.includes("qwen"));
  if (!hasThinking) return parts;
  const modes = l.includes("deepseek-v4") ? ["low", "medium", "high", "max"] : ["low", "medium", "high"];
  const tagMap: Record<string, string> = { low: toSmallCaps("lo"), medium: toSmallCaps("md"), high: toSmallCaps("hi"), max: toSmallCaps("mx") };
  return `💡 ${parts} [${modes.map(m => tagMap[m] || m).join(", ")}]`;
}

async function fetchZenModels(): Promise<void> {
  if (_zenModelsLoaded) return;
  try {
    const resp = await fetch("https://opencode.ai/zen/go/v1/models", { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data: any = await resp.json();
      _zenModels = (data?.data || []).map((m: any) => typeof m === "string" ? m : m.id || "").filter((id: string) => id.length > 0);
    }
  } catch {}
  if (_zenModels.length === 0) _zenModels = [...ZENITH_FALLBACK];
  _zenModelsLoaded = true;
}

function getZenModels(): any[] {
  if (!_zenModelsLoaded) fetchZenModels();
  const list = _zenModels.length > 0 ? _zenModels : ZENITH_FALLBACK;
  return list.map((id: string) => {
    const enabled = _modelStates[id] !== false;
    return { id, name: formatModelName(id), provider: "zen", enabled, free: false, locked: false };
  });
}

function getOcModels(): any[] {
  const modelIds = getModelIds();
  const canShowPremium = _hasValidKey;
  return modelIds.map((id: string) => {
    const isFree = id.startsWith("pol/");
    const family = getModelFamily(id);
    return {
      id, name: formatModelName(id), provider: "opencode",
      family: family || (isFree ? "pollinations" : "unknown"),
      enabled: canShowPremium ? (_modelStates[id] !== false) : isFree,
      free: isFree, locked: !isFree && !canShowPremium,
    };
  });
}

function getPathname(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

export async function handleDashboard(req: HandlerInput): Promise<HandlerResult> {
  const pathname = getPathname(req.url);
  const method = req.method.toUpperCase();

  // Serve dashboard HTML — always available
  if (pathname === "/dashboard" || pathname === "/") {
    const html = getDashboardHtml();
    return {
      handled: true,
      response: {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "connection": "close", "access-control-allow-origin": "*" },
        body: Buffer.from(html),
      },
    };
  }

  // Single initial-load endpoint — returns full config + status snapshot
  if (pathname === "/api/init" && method === "GET") {
    if (_validKeys.size === 0 && _keys.some(k => k.provider === "opencode")) {
      await validateOpencodeKeys().catch(() => {});
    }
    return { handled: true, response: jsonResponse(takeSnapshot()) };
  }

  return { handled: false };
}

export function detectWorkspaceId(input: string): string | null {
  if (!input) return null;
  // Full URL pattern: https://opencode.ai/workspace/wrk_...
  const urlMatch = input.match(/opencode\.ai\/workspace\/(wrk_[a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // Raw ID pattern: wrk_...
  const rawMatch = input.match(/^(wrk_[a-zA-Z0-9]+)$/);
  if (rawMatch) return rawMatch[1];
  return null;
}

// ── OpenCode Workspace Usage Cache ──
let _workspaceCache: KeyWorkspaceData[] = [];
let _workspaceCacheTime = 0;
const WORKSPACE_CACHE_TTL = 60000;

async function fetchWorkspaceUsageData(): Promise<KeyWorkspaceData[]> {
  // Try all possible session sources
  const envSession = (process.env.OPENCODE_SESSION || "").trim();
  if (envSession && !_ocSessionCookie) _ocSessionCookie = envSession;
  const globalSession = _ocSessionCookie || _zenSessionCookie || "";
  const opencodeKeys = _keys.filter(k => k.provider === "opencode");
  const sessions = new Set<string>();
  for (const k of opencodeKeys) { const s = k.session || globalSession; if (s) sessions.add(s); }
  if (globalSession) sessions.add(globalSession);
  if (sessions.size === 0) return [];
  const data: KeyWorkspaceData[] = [];
  for (const session of sessions) {
    const k = opencodeKeys.find(k => k.session === session);
    const keyName = k?.name || "Unknown Key";
    const keyToken = k?.token || "";
    const keyPrefix = keyToken ? `${keyToken.slice(0, 6)}...${keyToken.slice(-4)}` : "none";
    const keyId = keyToken ? keyToken.slice(0, 8) : "none";
    try {
      const wsData = await getWorkspaceDataForKey(keyToken, keyName, session);
      wsData.keyToken = keyToken;
      console.log(`[WS DEBUG] session=${session.slice(0, 10)}... workspaces=${wsData.workspaces.length} error=${wsData.error || "none"}`);
      data.push(wsData);
    } catch (e: any) {
      console.log(`[WS DEBUG] fetch failed: ${e.message}`);
      data.push({ keyPrefix, keyId, keyName, keyToken, session, error: e.message, workspaces: [] });
    }
  }
  return data;
}

async function getWorkspaceUsage(): Promise<{ cached: boolean; data: KeyWorkspaceData[] }> {
  const now = Date.now();
  if (_workspaceCache.length > 0 && now - _workspaceCacheTime < WORKSPACE_CACHE_TTL) {
    return { cached: true, data: _workspaceCache };
  }
  try {
    const data = await fetchWorkspaceUsageData();
    _workspaceCache = data;
    _workspaceCacheTime = now;
    return { cached: false, data };
  } catch {
    return { cached: true, data: _workspaceCache };
  }
}

export function incrementRequests() { _requestCount++; }

// Debug endpoint
export function getSessionDebugInfo(): Record<string, any> {
  return {
    ocSessionCookie: _ocSessionCookie ? `${_ocSessionCookie.slice(0, 16)}...${_ocSessionCookie.slice(-8)}` : "(empty)",
    ocSessionCookieLen: _ocSessionCookie.length,
    zenSessionCookie: _zenSessionCookie ? `${_zenSessionCookie.slice(0, 8)}...` : "(empty)",
    opencodeKeys: _keys.filter(k => k.provider === "opencode").map(k => ({
      name: k.name,
      hasSession: !!k.session,
      sessionPrefix: k.session ? k.session.slice(0, 10) + "..." : "",
    })),
    workspaceCacheEntries: _workspaceCache.length,
    workspaceCacheTime: _workspaceCacheTime,
  };
}
