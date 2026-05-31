// Dashboard handler — serves web dashboard HTML + JSON API endpoints
// Always intercepted (even in proxy mode) at /dashboard and /api/* paths

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HandlerInput, HandlerResult, jsonResponse, getProjectRoot, getMode, setMode } from "../shared.ts";
import { getModelIds, getModelFamily, getModelDisplayName } from "./opencode-client.ts";
import { getTps, restoreTerminal } from "../split-console.ts";
import { getUsageData, getPercentages, setZenStats } from "../usage-tracker.ts";

let _requestCount = 0;
let _config: any = {};

const PROVIDER_OPTIONS = [
  { id: "opencode", name: "OpenCode" },
  { id: "zen", name: "ZEN" },
];

let _modelStates: Record<string, boolean> = {};
let _validKeys = new Set<string>();
let _hasValidKey = false;
let _keyBalances: Record<string, any> = {};

// Unified keys — single source of truth for all providers
let _keys: { name: string; token: string; session: string; provider: string }[] = [];
let _zenSessionCookie = "";
let _zenEmail = "";
let _zenPassword = "";
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

// Hardcoded ZEN models (provider/slug format like the ZEN proxy)
const ZENITH_MODELS = [
  "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash-full", "deepseek/deepseek-v4-flash-precision", "deepseek/deepseek-v4-pro-full", "deepseek/deepseek-v4-pro-precision", "deepseek/deepseek-v3.2",
  "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro-full", "xiaomi/mimo-v2.5-pro-precision", "xiaomi/mimo-v2-pro", "xiaomi/mimo-v2-omni",
  "alibaba/qwen-3.5-397b-a17b", "alibaba/qwen-3.5-9b", "alibaba/qwen-3.6-27b", "alibaba/qwen-3.6-27b-full", "alibaba/qwen-3.6-plus",
  "google/gemma-4-31b", "google/gemma-4-31b-it-precision",
  "minimax/minimax-m2.5", "minimax/minimax-m2.5-speed", "minimax/minimax-m2.7", "minimax/minimax-m2.7-speed",
  "moonshot/kimi-k2.5", "moonshot/kimi-k2.6", "moonshot/kimi-k2.6-precision", "moonshot/kimi-k2.6-smart",
  "stepfun/step-3.5-flash", "stepfun/step-3.5-flash-2603",
  "zhipu/glm-4.7", "zhipu/glm-4.7-flash", "zhipu/glm-5", "zhipu/glm-5.1", "zhipu/glm-5.1-full", "zhipu/glm-5.1-precision",
  "xai/grok-imagine-image",
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
} catch (e) {}

// Load persisted keys from .config/config.json on startup
loadZenConfig();

function defaultProvider(): string {
  return _keys.some(k => k.provider === "zen") ? "zen" : "opencode";
}

function loadZenConfig() {
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf-8"));
      if (c.ZENITH_SESSION && !_zenSessionCookie) _zenSessionCookie = c.ZENITH_SESSION;
      if (c.ZENITH_EMAIL) _zenEmail = c.ZENITH_EMAIL;
      if (c.ZENITH_PASSWORD) _zenPassword = c.ZENITH_PASSWORD;
      if (c.TOKENS && Array.isArray(c.TOKENS)) {
        for (const t of c.TOKENS) {
          if (t.token && !_keys.find(x => x.token === t.token)) {
            _keys.push({ name: t.name || "Key", token: t.token, session: t.session || "", provider: t.provider || "zen" });
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
  if (sessions.length === 0) return { loggedIn: false, requests: 0, tokens: 0, cost: 0, balance: 0, keysCount: 0 };
  let totalRequests = 0, totalTokens = 0, totalCost = 0, totalBalance = 0, anyLoggedIn = false;
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

function getZenModels(): any[] {
  return _zenModels.length > 0
    ? _zenModels.map((id: string) => {
        const enabled = _modelStates[`zen:${id}`] !== false;
        return { id, name: formatModelName(id), provider: "zen", enabled, free: false, locked: false };
      })
    : ZENITH_MODELS.map((id: string) => {
        const enabled = _modelStates[`zen:${id}`] !== false;
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

function getStatusJson(): Record<string, any> {
  const mode = getMode().toUpperCase();
  const provider = _config?.provider || defaultProvider();
  const models = provider === "zen" ? getZenModels() : getOcModels();
  return {
    status: "ok", mode,
    requests: _requestCount, tps: getTps(),
    runtime: getRuntime(),
    port: process.env.gc2xy_HTTP_PORT || "80",
    target: process.env.TARGET_HOST || "github.com",
    cacheHits: 0,
    modelCount: models.length,
    enabledModelCount: models.filter((m: any) => m.enabled !== false).length,
    provider,
    hasValidKey: provider === "zen" ? _keys.filter(k => k.provider === "zen").length > 0 : _hasValidKey,
    models,
  };
}

function getPathname(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

export async function handleDashboard(req: HandlerInput): Promise<HandlerResult> {
  const pathname = getPathname(req.url);
  const method = req.method.toUpperCase();

  // Serve dashboard HTML
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

  // API: Status
  if (pathname === "/api/status") {
    if (_validKeys.size === 0 && _keys.some(k => k.provider === "opencode")) {
      validateOpencodeKeys().catch(() => {});
    }
    return { handled: true, response: jsonResponse(getStatusJson()) };
  }

  // API: Provider
  if (pathname === "/api/provider") {
    if (method === "GET") {
      return { handled: true, response: jsonResponse({ provider: _config?.provider || defaultProvider(), providers: PROVIDER_OPTIONS }) };
    }
    if (method === "POST") {
      try {
        const bodyStr = req.body ? Buffer.from(req.body).toString("utf-8") : "{}";
        const body = JSON.parse(bodyStr);
        if (body.provider) {
          _config = { ...(_config || {}), provider: body.provider };
          saveZenConfig();
        }
        return { handled: true, response: jsonResponse({ success: true, provider: _config?.provider || defaultProvider() }) };
      } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 400) }; }
    }
  }

  // API: Models toggle
  if (pathname === "/api/models") {
    if (method === "GET") {
      return { handled: true, response: jsonResponse({ models: getStatusJson().models }) };
    }
    if (method === "POST") {
      try {
        const bodyStr = req.body ? Buffer.from(req.body).toString("utf-8") : "{}";
        const body = JSON.parse(bodyStr);
        if (body.modelId && body.enabled !== undefined) _modelStates[body.modelId] = body.enabled;
        if (body.states) _modelStates = { ..._modelStates, ...body.states };
        return { handled: true, response: jsonResponse({ success: true, modelStates: _modelStates }) };
      } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 400) }; }
    }
  }

  // Health
  if (pathname === "/health") {
    return { handled: true, response: jsonResponse({
      status: _hasValidKey ? "ok" : "degraded", version: "3.0", cwd: process.cwd(),
      platform: process.platform, runtime: getRuntime(), hasValidKey: _hasValidKey,
    })};
  }

  // API: Config
  if (pathname === "/api/config") {
    if (method === "GET") {
      const provider = _config?.provider || defaultProvider();
      const models = provider === "zen" ? getZenModels() : getOcModels();
      return { handled: true, response: jsonResponse({
        ..._dashboardConfig, keys: _keys, zenSessionCookie: !!_zenSessionCookie,
        mode: getMode(), hasValidKey: _hasValidKey, validKeyCount: _validKeys.size,
        provider, models, zenLoggedIn: !!_zenSessionCookie,
      })};
    }
    if (method === "POST") {
      try {
        const bodyStr = req.body ? Buffer.from(req.body).toString("utf-8") : "{}";
        const body = JSON.parse(bodyStr);
        const { keys: _, ...safeBody } = body;
        _dashboardConfig = { ..._dashboardConfig, ...safeBody };
        if (body.mode && typeof body.mode === "string") {
          const newMode = body.mode.toLowerCase();
          if (newMode !== getMode()) setMode(newMode as any);
        }
        if (body.models) for (const m of body.models) _modelStates[m.id] = m.enabled !== false;
        if (body.provider) {
          _config = { ...(_config || {}), provider: body.provider };
          saveZenConfig();
        }
        validateOpencodeKeys().catch(() => {});
        return { handled: true, response: jsonResponse({ success: true, config: _dashboardConfig }) };
      } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 400) }; }
    }
  }

  // API: Restart
  if (pathname === "/api/restart" && method === "POST") {
    setTimeout(() => {
      try { restoreTerminal(); } catch {}
      try { unlinkSync(".proxy-host-pid"); } catch {}
      process.exit(42);
    }, 500);
    return { handled: true, response: jsonResponse({ success: true, message: "Restarting..." }) };
  }

  // API: Bing Background
  if (pathname === "/api/bg") {
    try {
      const resp = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1", { headers: { "User-Agent": "gc2xy/3.0" } });
      const data = await resp.json();
      const url = data?.images?.[0]?.url;
      if (url) return { handled: true, response: jsonResponse({ url: "https://www.bing.com" + url }) };
      return { handled: true, response: jsonResponse({ error: "not found" }, 404) };
    } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 500) }; }
  }

  // API: Validate Keys
  if (pathname === "/api/keys/validate" && method === "POST") {
    await validateOpencodeKeys();
    return { handled: true, response: jsonResponse({
      success: true, hasValidKey: _hasValidKey,
      keys: _keys.map(k => ({
        name: k.name, provider: k.provider,
        token: k.token, has_token: !!k.token, has_session: !!k.session,
        valid: k.provider === "opencode" ? _validKeys.has(k.token) : false,
        balance: k.provider === "opencode" ? (_keyBalances[k.token] || null) : null,
      })),
    })};
  }

  // API: Unified Keys CRUD (provider-agnostic)
  if (pathname === "/api/keys") {
    if (method === "GET") {
      const provider = _config?.provider || defaultProvider();
      return { handled: true, response: jsonResponse({
        provider,
        keys: _keys.filter(k => k.provider === provider),
        allKeys: _keys,
      })};
    }
    if (method === "POST") {
      try {
        const bodyStr = req.body ? Buffer.from(req.body).toString("utf-8") : "{}";
        const body = JSON.parse(bodyStr);
        if (body.action === "add") {
          const provider = body.provider || _config?.provider || defaultProvider();
          _keys.push({ name: body.name || `Key ${_keys.length + 1}`, token: body.token || "", session: body.session || "", provider });
          saveZenConfig();
          return { handled: true, response: jsonResponse({ success: true, keys: _keys.filter(k => k.provider === provider) }) };
        } else if (body.action === "update") {
          if (typeof body.index !== "number" || !_keys[body.index]) return { handled: true, response: jsonResponse({ error: "Key not found" }, 404) };
          if (body.name !== undefined) _keys[body.index].name = body.name;
          if (body.token !== undefined) _keys[body.index].token = body.token;
          if (body.session !== undefined) _keys[body.index].session = body.session;
          saveZenConfig();
          const provider = _keys[body.index].provider;
          return { handled: true, response: jsonResponse({ success: true, keys: _keys.filter(k => k.provider === provider) }) };
        } else if (body.action === "delete") {
          if (typeof body.index !== "number" || !_keys[body.index]) return { handled: true, response: jsonResponse({ error: "Key not found" }, 404) };
          const provider = _keys[body.index].provider;
          _keys.splice(body.index, 1);
          saveZenConfig();
          return { handled: true, response: jsonResponse({ success: true, keys: _keys.filter(k => k.provider === provider) }) };
        }
        return { handled: true, response: jsonResponse({ error: "Unknown action" }, 400) };
      } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 400) }; }
    }
  }

  // API: ZEN Login
  if (pathname === "/api/zen/login") {
    if (method === "POST") {
      try {
        const bodyStr = req.body ? Buffer.from(req.body).toString("utf-8") : "{}";
        const body = JSON.parse(bodyStr);
        if (body.sessionCookie) {
          _zenSessionCookie = body.sessionCookie;
          for (const k of _keys) { if (k.provider === "zen" && !k.session) k.session = body.sessionCookie; }
          saveZenConfig();
          return { handled: true, response: jsonResponse({ success: true }) };
        }
        return { handled: true, response: jsonResponse({ error: "Provide sessionCookie" }, 400) };
      } catch (e: any) { return { handled: true, response: jsonResponse({ error: e.message }, 400) }; }
    }
    if (method === "DELETE") { _zenSessionCookie = ""; saveZenConfig(); return { handled: true, response: jsonResponse({ success: true }) }; }
    if (method === "GET") {
      return { handled: true, response: jsonResponse({ loggedIn: !!_zenSessionCookie, oauth: { google: "https://api.zenllm.org/auth/google", discord: "https://api.zenllm.org/auth/discord" } }) };
    }
  }

  // API: ZEN Dashboard Stats
  if (pathname === "/api/zenith/requests") {
    try {
      loadZenConfig();
      const stats = await fetchZenithStats();
      setZenStats(stats);
      return { handled: true, response: jsonResponse(stats) };
    } catch (e) {
      return { handled: true, response: jsonResponse({ loggedIn: false, requests: 0, tokens: 0, cost: 0, balance: 0 }) };
    }
  }

  // API: Usage breakdown by endpoint
  if (pathname === "/api/usage") {
    const data = getUsageData();
    const pcts = getPercentages();
    return { handled: true, response: jsonResponse({ ...data, percentages: pcts }) };
  }

  return { handled: false };
}

export function incrementRequests() { _requestCount++; }
