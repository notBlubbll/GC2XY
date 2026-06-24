// Dashboard handler — serves web dashboard HTML + JSON API endpoints
// Always intercepted (even in proxy mode) at /dashboard and /api/* paths
// Status/data pushes to WebSocket clients on change only (delta-based)

import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { TextDecoder } from "node:util";

const DASHBOARD_START_TIME = new Date().toISOString();
import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";

const FREEGEN_PROMPT_SIGNER = "https://prompt-signer.freegen.app/api/test";
const FREEGEN_IMAGE_GENERATOR = "https://image-generator.freegen.app/api/test";
const FREEGEN_WS_BRIDGE = "wss://websocket-bridge.freegen.app/ws";

import { HandlerInput, HandlerResult, jsonResponse, getProjectRoot, getMode, setMode, killPortProcess, readJsonSync, getModelProviderTag } from "../shared.ts";
import { setGithubSku, setGithubUsername, setGithubDisplayName, getGithubSku, getGithubUsername, getGithubDisplayName } from "../shared.ts";
import { getModelFamily, getModelDisplayName, chatCompletion as openAIChat, getModelCtx, modelHasVision } from "./openai-provider.ts";
import { getFreebuffModelIds, getFreebuffModelPremium, chatCompletion as freebuffChat } from "./freebuff-client.ts";
import { getModelIds as getBitnetModelIds, chatCompletion as bitnetChat } from "./bitnet-client.ts";
import { chatCompletion as agnesChat } from "./agnes-client.ts";
import { chatCompletion as codestralChat } from "./codestral-client.ts";
import { initSupermaven, getSupermavenStatus, setSupermavenEnabled } from "./supermaven-client.ts";
import {
  setUmansConfig, loginToApp as umansLoginToApp, logoutApp as umansLogoutApp,
  fetchUsage as fetchUmansUsage, fetchConcurrency as fetchUmansConcurrency,
  fetchUsageHistory as fetchUmansUsageHistory, fetchKeysFromApp,
  refreshUmansState,
  setUmansEmail, setUmansPassword, setUmansAppSession, setUmansKeys, setUmansEnabledModels,
  setUmansCurrentKeyIndex, getCurrentKeyIndex as getUmansCurrentKeyIndex,
  getUmansConfig, getModelDisplayName as getUmansModelDisplayName,
  onUmansLoginStateChange, maybeRefreshAccountUserId,
  extractUsageBuckets as extractUmansUsageBuckets,
  chatCompletion as umansChat,
  setUmansVisionHandoff, getUmansVisionHandoff, getUmansCacheStats, clearUmansCache,
} from "./umans-client.ts";
import { getModelIds } from "../models.ts";
import { getTps, restoreTerminal, setEnabledModelIds } from "../split-console.ts";
import { ensureI18nForLocale, buildI18nBundle, getDashboardLocale, getForcedLocale, getUmansTranslationKey, setForcedLocale, setUmansTranslationApiKey } from "../i18n.ts";

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
    if (_genProgress.kind !== null && _genProgress.progress < 100) {
      ws.send(JSON.stringify({ type: "progress", data: _genProgress }));
    }
    ws.on("close", () => _wsClients.delete(ws));
    ws.on("message", (raw) => {
      try { const msg = JSON.parse(raw.toString()); handleWsMessage(ws, msg).catch(() => {}); } catch {}
    });
    ws.on("error", () => _wsClients.delete(ws));
  });
  killPortProcess(WS_PORT);
  srv.on("error", (err: Error) => {
    if ((err as any).code === "EADDRINUSE") {
      console.log(`[WS] Port ${WS_PORT} in use, retrying...`);
      killPortProcess(WS_PORT);
      setTimeout(() => { try { srv.listen(WS_PORT, "127.0.0.1"); } catch {} }, 1000);
    } else {
      console.log(`[WS] Server error: ${err.message}`);
    }
  });
  _wss.on("error", (err: Error) => {
    console.log(`[WS] WebSocketServer error: ${err.message}`);
  });
  try {
    srv.listen(WS_PORT, "127.0.0.1");
  } catch (err) {
    console.log(`[WS] Listen failed: ${(err as Error).message}`);
  }
  return _wss;
}

// ── Test Chat helpers ──
async function summarizeSseTestChat(rawSse: string, model: string): Promise<any> {
  const lines = rawSse.split("\n");
  let content = "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content || "";
      if (delta) content += delta;
    } catch {}
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: content || "(empty response)" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Snapshot / Diff System ──
let _lastSnapshot: Record<string, any> = {};

function takeSnapshot(): Record<string, any> {
  const models = getModels();
  // Group models by provider tag
  const grouped: Record<string, any[]> = {};
  for (const m of models) {
    const pt = (m as any).providerTag || "unknown";
    if (!grouped[pt]) grouped[pt] = [];
    grouped[pt].push({ id: m.id, name: m.name, family: m.family, providerTag: pt, enabled: m.enabled !== false, free: !!m.free, locked: !!m.locked });
  }
  return {
    status: {
      mode: getMode().toUpperCase(),
      requests: _requestCount,
      tps: getTps(),
      modelCount: models.length,
      enabledModelCount: models.filter((m: any) => m.enabled !== false).length,
      workDir: getProjectRoot(),
      port: process.env.gc2xy_HTTP_PORT || (process.env.IIS_PROXY === "1" ? "3080" : "80"),
      startedAt: getStartedAt(),
    },
    providers: _activeProviders,
    models: models.map(m => ({ id: m.id, name: m.name, family: m.family, providerTag: (m as any).providerTag || "unknown", enabled: m.enabled !== false, free: !!m.free, locked: !!m.locked })),
    groupedModels: grouped,
    health: { status: "ok", runtime: getRuntime(), platform: process.platform },
    wallpaper: _wallpaperSource,
    wallpaperPrompt: _wallpaperPrompt,
    freegenPrompt: _wallpaperPrompt,
    agnesKey: _agnesApiKey ? `${_agnesApiKey.slice(0, 5)}...${_agnesApiKey.slice(-4)}` : "",
    hasAgnesKey: !!_agnesApiKey,
    completionsModel: _completionsModel,
    supermaven: (() => {
      const st = getSupermavenStatus();
      return { enabled: _supermavenEnabled, initialized: st.initialized, binaryPath: st.binaryPath };
    })(),
    codestralKey: _codestralApiKey ? `${_codestralApiKey.slice(0, 5)}...${_codestralApiKey.slice(-4)}` : "",
    hasCodestralKey: !!_codestralApiKey,
    wallpaperProgress: _genProgress,
    githubSettings: {
      skuMode: getGithubSku(),
      username: getGithubUsername(),
      displayName: getGithubDisplayName(),
    },
    umans: _umansState,
    umansUserId: _umansState.userId || (_umansState.concurrency ? _umansState.concurrency.user_id : null) || null,
    umansUsage: _umansUsageCache,
    umansUsageHistory: _umansUsageHistoryCache,
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
  _pushModelStatesToConsole();
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
let _umansRefreshTimer: ReturnType<typeof setInterval> | null = null;
export function startWsPushLoop() { if (!_pushTimer) _pushTimer = setInterval(() => pushStatusToWs(), 2000); startUmansRefreshLoop(); }
export function stopWsPushLoop() { if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; } if (_umansRefreshTimer) { clearInterval(_umansRefreshTimer); _umansRefreshTimer = null; } }

function startUmansRefreshLoop() {
  if (_umansRefreshTimer) return;
  _umansRefreshTimer = setInterval(async () => {
    if (!_umansState.loggedIn && !getUmansConfig().appSession) return;
    try {
      const usage = await fetchUmansUsage();
      const history = await fetchUmansUsageHistory();
      const concurrency = await fetchUmansConcurrency().catch(() => ({ concurrent: 0, limit: null, user_id: null }));
      if (usage) { _umansUsageCache = usage; _umansUsageCacheTime = Date.now(); broadcastUmansUsage(usage); }
      if (history) { _umansUsageHistoryCache = history; _umansUsageHistoryCacheTime = Date.now(); pushUmansUsageHistory(history); }
      if (concurrency) { _umansState.concurrency = concurrency; if (concurrency.user_id) _umansState.userId = concurrency.user_id; broadcastUmansConcurrency(concurrency); }
    } catch {}
  }, 30000);
}

function pushUmansUsageHistory(history: any) {
  const msg = JSON.stringify({ type: "umansUsageHistory", data: history });
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function detectDashboardLocale(payload?: any): string {
  if (payload?.locale) return String(payload.locale).toLowerCase().split(/[-_]/)[0].slice(0, 8);
  if (payload?.nav) return String(payload.nav).toLowerCase().split(/[-_]/)[0].slice(0, 8);
  return "en";
}

async function handleWsMessage(ws: WebSocket, msg: any) {
  const { action, payload } = msg;
  if (action !== "testChat" && action !== "getI18nConfig" && action !== "getI18nBundle") {
    console.log(`[WS] action=${action}`);
  }
  switch (action) {
    case "setMode": {
      if (payload?.mode) setMode(payload.mode.toLowerCase());
      pushStatusToWs();
      break;
    }
    case "toggleModel": {
      if (payload?.modelId && payload?.enabled !== undefined) _modelStates[payload.modelId] = payload.enabled;
      console.log(`[CONFIG] toggleModel: ${payload?.modelId} = ${payload?.enabled}`);
      saveConfig();
      _pushModelStatesToConsole();
      pushStatusToWs();
      break;
    }
    case "batchModelStates": {
      if (payload?.states && Object.keys(payload.states).length > 0) { _modelStates = { ..._modelStates, ...payload.states }; saveConfig(); _pushModelStatesToConsole(); }
      pushStatusToWs();
      break;
    }
    case "setWallpaper": {
      if (payload?.source) {
        _wallpaperSource = payload.source;
        if (payload.prompt !== undefined && payload.prompt !== _wallpaperPrompt) {
          _wallpaperPrompt = payload.prompt;
          const { current, pending } = freegenWallpaperPaths();
          try { if (existsSync(current)) unlinkSync(current); } catch {}
          try { if (existsSync(pending)) unlinkSync(pending); } catch {}
        }
        saveConfig();
        if (_wallpaperSource === "ai") {
          generateFreegenWallpaperToDisk({ forceApply: true }).catch(() => {});
        } else if (_wallpaperSource !== "none") {
          ensureWallpaperCached(_wallpaperSource).then(() => {
            sendWallpaperData();
          }).catch(() => {});
        }
        const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
        for (const client of _wsClients) {
          if (client.readyState === WebSocket.OPEN) client.send(msg);
        }
        sendWallpaperData();
      }
      break;
    }
    case "generateFreegenWallpaper": {
      if (payload?.prompt && payload.prompt !== _wallpaperPrompt) {
        _wallpaperPrompt = payload.prompt;
        const { current, pending } = freegenWallpaperPaths();
        try { if (existsSync(current)) unlinkSync(current); } catch {}
        try { if (existsSync(pending)) unlinkSync(pending); } catch {}
        saveConfig();
      }
      _wallpaperSource = "ai";
      generateFreegenWallpaperToDisk({ forceApply: true }).catch(() => {});
      break;
    }
    case "getBingBg": {
      if (payload?.source) _wallpaperSource = payload.source;
      if (_wallpaperSource === "ai") {
        const { current } = freegenWallpaperPaths();
        if (existsSync(current)) {
          sendWallpaperData(ws);
        }
        generateFreegenWallpaperToDisk().then(() => {
          const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
          ws.send(msg);
          sendWallpaperData(ws);
        }).catch(() => {});
      } else if (_wallpaperSource !== "none") {
        ensureWallpaperCached(_wallpaperSource).then(() => {
          sendWallpaperData(ws);
        }).catch(() => {});
      }
      const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
      ws.send(msg);
      sendWallpaperData(ws);
      break;
    }
    case "getI18nConfig": {
      const hasKey = !!getUmansTranslationKey();
      const forced = getForcedLocale();
      const fallbackLocale = forced || (hasKey ? (payload?.nav || "en") : "en");
      const reply: any = { type: "i18nConfig", data: { has_key: hasKey, forced_locale: forced, fallback_locale: fallbackLocale } };
      if (payload?._id) reply._id = payload._id;
      ws.send(JSON.stringify(reply));
      break;
    }
    case "getI18nBundle": {
      const locale = String(payload?.locale || "en").toLowerCase().split(/[-_]/)[0].slice(0, 8);
      const generate = !!payload?.generate;
      try {
        const hasKey = !!getUmansTranslationKey();
        const forced = getForcedLocale();
        let bundle: any;
        if (!hasKey || locale === "en") {
          bundle = buildI18nBundle("en");
          bundle = { ...bundle, has_key: hasKey, forced_locale: forced, fallback_locale: "en" };
        } else if (generate) {
          bundle = await ensureI18nForLocale(locale);
          bundle = { ...bundle, has_key: true, forced_locale: forced, fallback_locale: locale };
        } else {
          bundle = buildI18nBundle(locale);
          bundle = { ...bundle, has_key: true, forced_locale: forced, fallback_locale: locale };
        }
        const reply: any = { type: "i18nBundle", data: bundle };
        if (payload?._id) reply._id = payload._id;
        ws.send(JSON.stringify(reply));
      } catch (e) {
        const fallback = buildI18nBundle("en");
        const reply: any = { type: "i18nBundle", data: { ...fallback, has_key: false, forced_locale: getForcedLocale(), fallback_locale: "en" } };
        if (payload?._id) reply._id = payload._id;
        ws.send(JSON.stringify(reply));
      }
      break;
    }
    case "restart": {
      ws.send(JSON.stringify({ type: "restarting", data: { success: true } }));
      setTimeout(() => {
        try { setMode(getMode()); } catch {}
        try { restoreTerminal(); } catch {}
        try { unlinkSync(join(getProjectRoot(), ".cache", "proxy-host-pid")); } catch {}
        process.exit(42);
      }, 500);
      break;
    }
    case "setGithubSettings": {
      if (payload?.skuMode) setGithubSku(payload.skuMode);
      if (payload?.username) setGithubUsername(payload.username);
      if (payload?.displayName) setGithubDisplayName(payload.displayName);
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "saveConfig": {
      if (payload) {
        const { keys: _, models: __, ...safeBody } = payload;
        _dashboardConfig = { ..._dashboardConfig, ...safeBody };
        if (payload.mode) setMode(payload.mode.toLowerCase());
        if (Array.isArray(payload.providers)) {
          const valid = ["umans", "freebuff", "agnes", "bitnet", "codestral"];
          _activeProviders = payload.providers.filter((p: string) => valid.includes(p));
        }
        if (payload.agnesKey !== undefined) {
          _agnesApiKey = payload.agnesKey || "";
          if (_agnesApiKey && _activeProviders.indexOf("agnes") === -1) _activeProviders.push("agnes");
          else if (!_agnesApiKey) { const idx = _activeProviders.indexOf("agnes"); if (idx !== -1) _activeProviders.splice(idx, 1); }
        }
        if (payload.codestralKey !== undefined) {
          _codestralApiKey = payload.codestralKey || "";
          if (_codestralApiKey && _activeProviders.indexOf("codestral") === -1) _activeProviders.push("codestral");
          else if (!_codestralApiKey) { const idx = _activeProviders.indexOf("codestral"); if (idx !== -1) _activeProviders.splice(idx, 1); }
        }
        if (payload.completionsModel) _completionsModel = payload.completionsModel;
        if (typeof payload.supermavenEnabled === "boolean") { _supermavenEnabled = payload.supermavenEnabled; setSupermavenEnabled(_supermavenEnabled); }
        saveConfig();
      }
      pushStatusToWs();
      break;
    }
    case "setAgnesKey": {
      _agnesApiKey = payload?.key || "";
      if (_agnesApiKey && _activeProviders.indexOf("agnes") === -1) {
        _activeProviders.push("agnes");
      } else if (!_agnesApiKey) {
        const idx = _activeProviders.indexOf("agnes");
        if (idx !== -1) _activeProviders.splice(idx, 1);
      }
      console.log(`[CONFIG] setAgnesKey: ${_agnesApiKey ? "set" : "cleared"}, providers: ${_activeProviders.join(", ")}`);
      saveConfig();
      _pushModelStatesToConsole();
      pushStatusToWs();
      break;
    }
    case "setCodestralKey": {
      _codestralApiKey = payload?.key || "";
      if (_codestralApiKey && _activeProviders.indexOf("codestral") === -1) {
        _activeProviders.push("codestral");
      } else if (!_codestralApiKey) {
        const idx = _activeProviders.indexOf("codestral");
        if (idx !== -1) _activeProviders.splice(idx, 1);
      }
      console.log(`[CONFIG] setCodestralKey: ${_codestralApiKey ? "set" : "cleared"}, providers: ${_activeProviders.join(", ")}`);
      saveConfig();
      _pushModelStatesToConsole();
      pushStatusToWs();
      break;
    }
    case "renameModel": {
      try {
        const modelId = payload?.modelId;
        const displayName = payload?.displayName;
        if (modelId) {
          if (displayName) {
            const { setDisplayNameOverride } = await import("./openai-provider.ts");
            setDisplayNameOverride(modelId, displayName);
          } else {
            const { setDisplayNameOverride } = await import("./openai-provider.ts");
            setDisplayNameOverride(modelId, "");
          }
          pushStatusToWs();
        }
      } catch {}
      break;
    }
    case "renameModelBulk": {
      try {
        const names = payload?.names as Record<string, string>;
        if (names) {
          const { setDisplayNameOverride } = await import("./openai-provider.ts");
          for (const [id, name] of Object.entries(names)) {
            if (name) setDisplayNameOverride(id, name);
            else setDisplayNameOverride(id, "");
          }
          pushStatusToWs();
        }
      } catch {}
      break;
    }
    case "setProviders": {
      const valid = ["umans", "freebuff", "agnes", "bitnet", "codestral"];
      if (Array.isArray(payload?.providers)) {
        _activeProviders = payload.providers.filter((p: string) => valid.includes(p));
        console.log(`[CONFIG] setProviders: ${_activeProviders.join(", ")}`);
        saveConfig();
        _pushModelStatesToConsole();
      }
      pushStatusToWs();
      break;
    }
    case "setSupermaven": {
      _supermavenEnabled = payload?.enabled === true;
      setSupermavenEnabled(_supermavenEnabled);
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "setCompletionsModel": {
      _completionsModel = payload?.modelId || "";
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "testChat": {
      try {
        const model: string = payload?.model;
        const messages: any[] = payload?.messages;
        const stream: boolean = payload?.stream !== false;
        const reqId = payload?._id;
        if (!model || !Array.isArray(messages)) {
          ws.send(JSON.stringify({ type: "testChatResult", data: { error: "Invalid request" }, _id: reqId }));
          break;
        }
        const provider = model.startsWith("umans-") ? "umans" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral/") ? "codestral" : (model.startsWith("bitnet/") || model === "bitnet-demo") ? "bitnet" : "unknown";
        const requestStart = Date.now();
        let resp: Response;
        if (provider === "umans") resp = await umansChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "freebuff") resp = await freebuffChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "agnes") resp = await agnesChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "codestral") resp = await codestralChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "bitnet") resp = await bitnetChat(model, messages, undefined, stream);
        else resp = await openAIChat(model, messages, undefined, stream, { max_tokens: 2048 });

        const responseCt = resp.headers.get("content-type") || "";
        const isJsonResponse = responseCt.includes("application/json");
        if (stream && resp.ok && resp.body && !isJsonResponse) {
          // Emit first-byte latency from LLM to server, then stream chunks over WS
          let firstByteLatency: number | null = null;
          const decoder = new TextDecoder();
          const reader = (resp.body as any).getReader ? (resp.body as any).getReader() : null;
          if (reader) {
            let chunkBuffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (firstByteLatency === null) firstByteLatency = Date.now() - requestStart;
              chunkBuffer += text;
              // Flush line-by-line so we don't split SSE events
              let eol: number;
              while ((eol = chunkBuffer.indexOf("\n\n")) !== -1) {
                const block = chunkBuffer.slice(0, eol);
                chunkBuffer = chunkBuffer.slice(eol + 2);
                if (block.trim()) {
                  ws.send(JSON.stringify({ type: "testChatChunk", chunk: block, model, provider, latencyMs: firstByteLatency, _id: reqId }));
                }
              }
            }
            // Emit any remaining complete line
            if (chunkBuffer.trim()) {
              ws.send(JSON.stringify({ type: "testChatChunk", chunk: chunkBuffer.trim(), model, provider, latencyMs: firstByteLatency, _id: reqId }));
            }
            const elapsedMs = Date.now() - requestStart;
            ws.send(JSON.stringify({ type: "testChatDone", model, provider, latencyMs: firstByteLatency, elapsedMs, _id: reqId }));
          } else {
            // Fallback: read whole body and summarize
            let rawSse = "";
            for await (const chunk of resp.body as any) { rawSse += decoder.decode(chunk, { stream: true }); }
            const data = await summarizeSseTestChat(rawSse, model);
            const elapsedMs = Date.now() - requestStart;
            ws.send(JSON.stringify({ type: "testChatResult", data, elapsedMs, _id: reqId }));
          }
        } else if (!resp.ok) {
          const err: any = await resp.json().catch(() => ({}));
          ws.send(JSON.stringify({ type: "testChatResult", data: { error: err?.error?.message || err?.error || `HTTP ${resp.status}` }, _id: reqId }));
        } else {
          const data: any = await resp.json();
          const elapsedMs = Date.now() - requestStart;
          const content = data?.choices?.[0]?.message?.content;
          if (!content) console.log(`[TEST CHAT] empty content from ${model}:`, JSON.stringify(data).slice(0, 500));
          ws.send(JSON.stringify({ type: "testChatResult", data, elapsedMs, _id: reqId }));
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "testChatResult", data: { error: e?.message || "request failed" }, _id: payload?._id }));
      }
      break;
    }
    case "umansLogin": {
      const email = payload?.email || "";
      const password = payload?.password || "";
      try {
        setUmansEmail(email);
        setUmansPassword(password);
        const ok = await umansLoginToApp(email, password);
        if (ok) {
          const state = await refreshUmansState();
          const concurrency = await fetchUmansConcurrency().catch(() => ({ concurrent: 0, limit: null, user_id: null }));
          const usageHistory = await fetchUmansUsageHistory().catch(() => null);
          _umansState = {
            loggedIn: true,
            email,
            keys: state.keys,
            currentKeyIndex: 0,
            enabledModels: _umansState.enabledModels || [],
            userId: state.userId || concurrency.user_id,
          };
          syncUmansTranslationKey();
          saveConfig();
          broadcastUmansState();
          _umansUsageCache = state.usage;
          _umansUsageCacheTime = Date.now();
          _umansUsageHistoryCache = usageHistory;
          _umansUsageHistoryCacheTime = Date.now();
          broadcastUmansUsage(state.usage);
          broadcastUmansConcurrency(concurrency);
          pushUmansUsageHistory(usageHistory);
          ws.send(JSON.stringify({ _id: payload?._id, success: true }));
        } else {
          ws.send(JSON.stringify({ _id: payload?._id, success: false, error: "Invalid email or password" }));
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ _id: payload?._id, success: false, error: e?.message || "Login request failed" }));
      }
      break;
    }
    case "umansLogout": {
      umansLogoutApp();
      _umansState = { loggedIn: false, email: "", keys: [], currentKeyIndex: 0, enabledModels: _umansState.enabledModels || [], userId: null };
      saveConfig();
      broadcastUmansState();
      ws.send(JSON.stringify({ type: "umansUsage", data: null }));
      ws.send(JSON.stringify({ type: "umansConcurrency", data: { concurrent: 0, limit: null, user_id: null } }));
      break;
    }
    case "umansAddKey": {
      const name = payload?.name || "Key";
      const key = payload?.key || "";
      if (key.length > 5) {
        const cfg = getUmansConfig();
        const keys = [...cfg.keys, { name, key }];
        setUmansKeys(keys);
        _umansState.keys = keys;
        syncUmansTranslationKey();
        saveConfig();
        broadcastUmansState();
      }
      break;
    }
    case "umansUpdateKey": {
      const idx = typeof payload?.index === "number" ? payload.index : -1;
      if (idx >= 0) {
        const cfg = getUmansConfig();
        const keys = [...cfg.keys];
        if (keys[idx]) {
          keys[idx] = { name: payload?.name || keys[idx].name, key: payload?.key || keys[idx].key };
          setUmansKeys(keys);
          _umansState.keys = keys;
          syncUmansTranslationKey();
          saveConfig();
          broadcastUmansState();
        }
      }
      break;
    }
    case "umansDeleteKey": {
      const idx = typeof payload?.index === "number" ? payload.index : -1;
      if (idx >= 0) {
        const cfg = getUmansConfig();
        const keys = [...cfg.keys];
        keys.splice(idx, 1);
        setUmansKeys(keys);
        _umansState.keys = keys;
        syncUmansTranslationKey();
        saveConfig();
        broadcastUmansState();
      }
      break;
    }
    case "umansSetKey": {
      const idx = typeof payload?.index === "number" ? payload.index : 0;
      setUmansCurrentKeyIndex(idx);
      _umansState.currentKeyIndex = getUmansCurrentKeyIndex();
      saveConfig();
      broadcastUmansState();
      break;
    }
    case "umansSetEnabledModels": {
      if (Array.isArray(payload?.models)) {
        setUmansEnabledModels(payload.models);
        _umansState.enabledModels = payload.models;
        saveConfig();
        broadcastUmansState();
      }
      break;
    }
    case "umansRefresh": {
      ws.send(JSON.stringify({ _id: payload?._id }));
      try {
        const keys = await fetchKeysFromApp();
        _umansState.keys = keys;
        const concurrency = await fetchUmansConcurrency().catch(() => ({ concurrent: 0, limit: null, user_id: null }));
        _umansState.userId = concurrency.user_id || _umansState.userId;
        syncUmansTranslationKey();
        saveConfig();
        broadcastUmansState();
        ws.send(JSON.stringify({ type: "umansUserId", data: { userId: _umansState.userId } }));
      } catch {}
      break;
    }
      case "umansRefreshUsage": {
      try {
        const usage = await fetchUmansUsage({ force: true });
        const concurrency = await fetchUmansConcurrency();
        const history = await fetchUmansUsageHistory({ force: true });
        _umansUsageCache = usage;
        _umansUsageCacheTime = Date.now();
        _umansUsageHistoryCache = history;
        _umansUsageHistoryCacheTime = Date.now();
        broadcastUmansUsage(usage);
        broadcastUmansConcurrency(concurrency);
        pushUmansUsageHistory(history);
      } catch {}
      break;
    }
    case "umansSetVisionHandoff": {
      try {
        const enabled = typeof payload?.enabled === "boolean" ? payload.enabled : getUmansVisionHandoff().enabled;
        const model = typeof payload?.model === "string" ? payload.model : undefined;
        const prompt = typeof payload?.prompt === "string" ? payload.prompt : undefined;
        setUmansVisionHandoff(enabled, model, prompt);
        _umansState.visionHandoff = { ...getUmansVisionHandoff() };
        saveConfig();
        broadcastUmansState();
        ws.send(JSON.stringify({ _id: payload?._id, ok: true }));
      } catch (e: any) {
        ws.send(JSON.stringify({ _id: payload?._id, error: e?.message || "failed" }));
      }
      break;
    }
    case "umansClearCache": {
      clearUmansCache();
      ws.send(JSON.stringify({ _id: payload?._id, ok: true, stats: getUmansCacheStats() }));
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

const PROVIDER_TAG_MAP: Record<string, string> = { freebuff: "freebuff", agnes: "agnes", codestral: "codestral", bitnet: "bitnet", umans: "umans", zen: "zen", openrouter: "openrouter" };
function activeModelTags(): Set<string> {
  const tags = new Set<string>();
  for (const p of _activeProviders) {
    const t = PROVIDER_TAG_MAP[p] || p; tags.add(t);
  }
  return tags;
}

function syncUmansTranslationKey() {
  const cfg = getUmansConfig();
  const key = (cfg.keys || []).find(k => k.key)?.key || "";
  setUmansTranslationApiKey(key);
}

let _requestCount = 0;

let _modelStates: Record<string, boolean> = {};

function _pushModelStatesToConsole() {
  const modelIds = getModelIds();

  const activeTags = activeModelTags();
  const enabled = new Set(modelIds.filter(id => activeTags.has(getModelProviderTag(id)) && _modelStates[id] !== false));
  setEnabledModelIds(enabled);
}
let _dashboardCache: any = {};
let _dashboardCacheTime = 0;
const DASHBOARD_CACHE_TTL = 30000;

let _wallpaperSource = "none";
let _wallpaperPrompt = "";

let _agnesApiKey = "";

let _codestralApiKey = "";

let _freegenGenRunning = false;
let _freegenGenPromise: Promise<string> | null = null;
let _freegenLastError = "";

let _genProgress: { kind: string | null; progress: number } = { kind: null, progress: 0 };
let _genResetTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastProgress() {
  const msg = JSON.stringify({ type: "progress", data: _genProgress });
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastUmansState() {
  const msg = JSON.stringify({ type: "umans", data: _umansState });
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastUmansUsage(usage: any) {
  const msg = JSON.stringify({ type: "umansUsage", data: usage });
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastUmansConcurrency(concurrency: any) {
  const msg = JSON.stringify({ type: "umansConcurrency", data: concurrency });
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}
function setGenProgress(kind: string, progress: number) {
  _genProgress = { kind, progress };
  broadcastProgress();
  if (_genResetTimer) { clearTimeout(_genResetTimer); _genResetTimer = null; }
  if (progress >= 100) {
    _genResetTimer = setTimeout(() => {
      _genProgress = { kind: null, progress: 0 };
      broadcastProgress();
      _genResetTimer = null;
    }, 60000);
  }
}

// ── Provider / Model Config ──
let _activeProviders: string[] = ["umans"];
let _completionsModel: string = "mistral-latest";
export function getCompletionsModel(): string { return _completionsModel; }
let _supermavenEnabled = false;

let _umansState: any = { loggedIn: false, email: "", keys: [], currentKeyIndex: 0, enabledModels: [], userId: null, visionHandoff: { enabled: true, model: "umans-kimi-k2.7", prompt: "" } };

let _dashboardConfig: Record<string, any> = {
  mode: "mock",
  httpPort: 80,
  iisProxy: false,
  keys: [],
  models: [],
  wallpaper: "none",
  agnesKey: "",
  providers: ["umans"],
};

// ── Wallpaper source and caching ──
function getCacheDir(): string {
  const d = join(getProjectRoot(), ".cache");
  if (!existsSync(d)) try { writeFileSync(join(d, ".gitkeep"), ""); } catch {}
  return d;
}

async function fetchBingWallpaper(): Promise<boolean> {
  const cachePath = join(getCacheDir(), "wallpaper-bing.jpg");
  const oneHour = 60 * 60 * 1000;
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < oneHour) return true;
  try {
    const resp = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1", { headers: { "User-Agent": "gc2xy/3.0" } });
    if (!resp.ok) return false;
    const d: any = await resp.json();
    const urlPart = d?.images?.[0]?.url;
    if (!urlPart) return false;
    const imgResp = await fetch("https://www.bing.com" + urlPart, { headers: { "User-Agent": "gc2xy/3.0" } });
    if (!imgResp.ok) return false;
    const buf = Buffer.from(await imgResp.arrayBuffer());
    writeFileSync(cachePath, buf);
    return true;
  } catch { return false; }
}

async function fetchWallhavenWallpaper(): Promise<boolean> {
  const cachePath = join(getCacheDir(), "wallpaper-haven.jpg");
  const oneHour = 60 * 60 * 1000;
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < oneHour) return true;
  try {
    const apiUrl = "https://wallhaven.cc/api/v1/search?categories=100&purity=100&topRange=1M&sorting=toplist&order=desc&page=3";
    const resp = await fetch(apiUrl, { headers: { "User-Agent": "gc2xy/3.0" } });
    if (!resp.ok) return false;
    const d: any = await resp.json();
    const data = d?.data;
    if (!Array.isArray(data) || data.length === 0) return false;
    const pick = data[Math.floor(Math.random() * data.length)];
    const imgUrl = pick?.path;
    if (!imgUrl) return false;
    const imgResp = await fetch(imgUrl, { headers: { "User-Agent": "gc2xy/3.0" } });
    if (!imgResp.ok) return false;
    const buf = Buffer.from(await imgResp.arrayBuffer());
    writeFileSync(cachePath, buf);
    return true;
  } catch { return false; }
}

async function fetchFreegenSigned(prompt: string): Promise<{ ts: number; sig: string }> {
  const resp = await fetch(FREEGEN_PROMPT_SIGNER, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "gc2xy/3.0" },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`signer ${resp.status}`);
  const data: any = await resp.json();
  if (!data.ts || !data.sig) throw new Error("signer missing ts/sig");
  return data;
}

async function fetchFreegenImageUrl(prompt: string, ratio = "16:9"): Promise<string> {
  const { ts, sig } = await fetchFreegenSigned(prompt);
  const resp = await fetch(FREEGEN_IMAGE_GENERATOR, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "gc2xy/3.0" },
    body: JSON.stringify({ prompt, ts, sig, ratio_id: ratio }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    let txt = "";
    try { txt = await resp.text(); } catch {}
    throw new Error(`generator ${resp.status}: ${txt}`);
  }
  const data: any = await resp.json();
  if (data.image_data_url) return data.image_data_url;
  if (data.job_id) return await waitFreegenWs(data.job_id);
  throw new Error("no image_data_url or job_id from freegen");
}

function waitFreegenWs(jobId: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      try { ws && ws.close(); } catch {}
      reject(new Error("freegen websocket timeout"));
    }, timeoutMs);
    try {
      ws = new WebSocket(FREEGEN_WS_BRIDGE, [], { headers: { Origin: "https://freegen.app" } } as any);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    ws.onopen = () => {
      try { ws && ws.send(JSON.stringify({ type: "subscribe", job_id: jobId, auth: Date.now().toString() })); } catch (e: any) { clearTimeout(timer); reject(e); }
    };
    ws.onmessage = (event: any) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "result" && msg.image_data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch {}
        resolve(msg.image_data);
      } else if (msg.type === "error") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch {}
        reject(new Error(msg.message || "freegen generation error"));
      }
    };
    ws.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      reject(new Error("freegen websocket error"));
    };
    ws.onclose = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error("freegen websocket closed"));
    };
  });
}

async function downloadImageToFile(imageUrl: string, filePath: string): Promise<Buffer> {
  const resp = await fetch(imageUrl, { headers: { "User-Agent": "gc2xy/3.0" }, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`download ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf || buf.length < 1024) throw new Error("image too small");
  writeFileSync(filePath, buf);
  return buf;
}

function freegenWallpaperPaths() {
  return {
    current: join(getCacheDir(), "wallpaper-freegen.jpg"),
    pending: join(getCacheDir(), "wallpaper-freegen.pending.jpg"),
  };
}

async function generateFreegenWallpaperToDisk({ prompt, ratio = "16:9", forceApply = false }: { prompt?: string; ratio?: string; forceApply?: boolean } = {}): Promise<string> {
  if (_freegenGenRunning) {
    console.log("[FreeGen] generation already in progress, waiting...");
    if (_freegenGenPromise) await _freegenGenPromise;
    return freegenWallpaperPaths().current;
  }
  _freegenGenRunning = true;
  _freegenLastError = "";
  setGenProgress("image", 0);
  _freegenGenPromise = (async () => {
    try {
      const { current, pending } = freegenWallpaperPaths();
      const finalPrompt = prompt || _wallpaperPrompt || "epic cinematic landscape, mountains at sunset, vibrant colors, ultra detailed, 16:9 wallpaper";
      console.log(`[FreeGen] generating wallpaper (ratio ${ratio})...`);
      const imageUrl = await fetchFreegenImageUrl(finalPrompt, ratio);
      await downloadImageToFile(imageUrl, pending);
      if (existsSync(current)) unlinkSync(current);
      renameSync(pending, current);
      console.log("[FreeGen] wallpaper saved and activated", current);
      if (forceApply) {
        _wallpaperSource = "ai";
        saveConfig();
      }
      setGenProgress("image", 100);
      const updated = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
      for (const client of _wsClients) {
        if (client.readyState === WebSocket.OPEN) client.send(updated);
      }
      sendWallpaperData();
      return current;
    } catch (e: any) {
      _freegenLastError = e?.message || String(e);
      console.log("[FreeGen] generation failed:", _freegenLastError);
      const errMsg = JSON.stringify({ type: "wallpaperError", data: { message: _freegenLastError } });
      for (const client of _wsClients) {
        if (client.readyState === WebSocket.OPEN) client.send(errMsg);
      }
      if (_genResetTimer) { clearTimeout(_genResetTimer); _genResetTimer = null; }
      _genProgress = { kind: null, progress: 0 };
      broadcastProgress();
      throw e;
    } finally {
      _freegenGenRunning = false;
      _freegenGenPromise = null;
    }
  })();
  return _freegenGenPromise;
}

function freegenBackgroundRefresh() {
  if (_freegenGenRunning || !_wallpaperPrompt) return;
  console.log("[FreeGen] background refresh queued");
  generateFreegenWallpaperToDisk({ forceApply: false }).catch(() => {});
}

async function fetchFreegenWallpaper(): Promise<boolean> {
  const { current } = freegenWallpaperPaths();
  const oneHour = 60 * 60 * 1000;
  if (existsSync(current) && Date.now() - statSync(current).mtimeMs < oneHour) return true;
  try {
    await generateFreegenWallpaperToDisk();
    return true;
  } catch { return false; }
}

async function ensureWallpaperCached(source: string): Promise<boolean> {
  if (source === "bing") return fetchBingWallpaper();
  if (source === "wallhaven") return fetchWallhavenWallpaper();
  if (source === "ai") return fetchFreegenWallpaper();
  return false;
}

export function getWallpaperSource(): string { return _wallpaperSource; }

function getWallpaperPath(source: string): string {
  if (source === "bing") return join(getCacheDir(), "wallpaper-bing.jpg");
  if (source === "wallhaven") return join(getCacheDir(), "wallpaper-haven.jpg");
  if (source === "ai") return join(getCacheDir(), "wallpaper-freegen.jpg");
  return "";
}

function sendWallpaperData(ws?: WebSocket) {
  const source = _wallpaperSource;
  if (source === "none") return;
  const path = getWallpaperPath(source);
  if (!path || !existsSync(path)) return;
  try {
    const buf = readFileSync(path);
    const dataUri = "data:image/jpeg;base64," + buf.toString("base64");
    const msg = JSON.stringify({ type: "wallpaperData", data: { source, dataUri } });
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    } else {
      for (const client of _wsClients) {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      }
    }
  } catch {}
}

// Load persisted keys from .config/config.json on startup
loadConfig();
saveConfig();

// Start Supermaven client in background (don't block startup)
initSupermaven().catch((e: any) => console.log("[Supermaven] Init error:", e.message));

function loadConfig() {
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = readJsonSync(p);
      if (c.wallpaper) _wallpaperSource = c.wallpaper;
      if (c.wallpaperPrompt || c.freegenPrompt) _wallpaperPrompt = c.freegenPrompt || c.wallpaperPrompt;
      if (c.providers && Array.isArray(c.providers)) {
        _activeProviders = c.providers.filter((p: string) => p !== "opencode" && p !== "go");
      } else if (c.provider) _activeProviders = [c.provider]; // migrate old single-value
      if (c.agnesKey) { _agnesApiKey = c.agnesKey; if (_activeProviders.indexOf("agnes") === -1) _activeProviders.push("agnes"); }
      if (c.codestralKey) { _codestralApiKey = c.codestralKey; if (_activeProviders.indexOf("codestral") === -1) _activeProviders.push("codestral"); }
      // migrate legacy providers out of active list
      if (_activeProviders.some((p: string) => ["opencode", "go", "poll", "featherless", "openrouter", "zen"].includes(p))) {
        _activeProviders = _activeProviders.filter((p: string) => !["opencode", "go", "poll", "featherless", "openrouter", "zen"].includes(p));
        if (_activeProviders.length === 0) _activeProviders = ["umans"];
      }
      if (c.githubSettings) {
        if (c.githubSettings.skuMode) setGithubSku(c.githubSettings.skuMode);
        if (c.githubSettings.username) setGithubUsername(c.githubSettings.username);
        if (c.githubSettings.displayName) setGithubDisplayName(c.githubSettings.displayName);
      }
      if (c.completionsModel) _completionsModel = c.completionsModel;
      if (typeof c.supermavenEnabled === "boolean") {
        _supermavenEnabled = c.supermavenEnabled;
        setSupermavenEnabled(_supermavenEnabled);
      }
      if (c.locale) setForcedLocale(c.locale);
      if (c.umans) {
        _umansState = { ..._umansState, ...c.umans };
        if (c.umans.email) setUmansEmail(c.umans.email);
        if (c.umans.password) setUmansPassword(c.umans.password);
        if (c.umans.appSession) setUmansAppSession(c.umans.appSession);
        if (Array.isArray(c.umans.keys)) setUmansKeys(c.umans.keys);
        if (Array.isArray(c.umans.enabledModels)) setUmansEnabledModels(c.umans.enabledModels);
        if (typeof c.umans.currentKeyIndex === "number") setUmansCurrentKeyIndex(c.umans.currentKeyIndex);
        if (typeof c.umans.visionHandoffEnabled === "boolean" || typeof c.umans.visionHandoffModel === "string" || typeof c.umans.visionHandoffPrompt === "string") {
          setUmansVisionHandoff(
            typeof c.umans.visionHandoffEnabled === "boolean" ? c.umans.visionHandoffEnabled : true,
            typeof c.umans.visionHandoffModel === "string" ? c.umans.visionHandoffModel : undefined,
            typeof c.umans.visionHandoffPrompt === "string" ? c.umans.visionHandoffPrompt : undefined,
          );
        }
        _umansState.visionHandoff = { ...getUmansVisionHandoff() };
        if (!c.umans.userId && _umansState.loggedIn) {
          maybeRefreshAccountUserId().then(uid => { if (uid) { _umansState.userId = uid; saveConfig(); pushStatusToWs(); } }).catch(() => {});
        } else if (c.umans.userId) {
          _umansState.userId = c.umans.userId;
        }
        syncUmansTranslationKey();
      }
      if (c.disabledModels && typeof c.disabledModels === "object") {
        for (const [tag, ids] of Object.entries(c.disabledModels as Record<string, string[]>)) {
          if (Array.isArray(ids)) for (const id of ids) _modelStates[id as string] = false;
        }
      }
      console.log(`[CONFIG] loaded from ${p}: ${_activeProviders.length} providers, ${Object.keys(_modelStates).length} model states`);
    } else {
      console.log(`[CONFIG] no config.json found at ${p}`);
    }
  } catch (e: any) {
    console.log(`[CONFIG] loadConfig failed: ${e?.message}`);
  }
}

function saveConfig() {
  try {
    const dir = join(getProjectRoot(), ".config");
    if (!existsSync(dir)) try { mkdirSync(dir, { recursive: true }); } catch {}
    const p = join(dir, "config.json");
    const existing = existsSync(p) ? readJsonSync(p) : {};
    existing.mode = getMode();
    existing.wallpaper = _wallpaperSource;
    existing.wallpaperPrompt = _wallpaperPrompt;
    existing.freegenPrompt = _wallpaperPrompt;
    existing.agnesKey = _agnesApiKey;
    existing.codestralKey = _codestralApiKey;
    existing.providers = _activeProviders;
    existing.completionsModel = _completionsModel;
    existing.supermavenEnabled = _supermavenEnabled;
    existing.locale = getForcedLocale();
    existing.githubSettings = { skuMode: getGithubSku(), username: getGithubUsername(), displayName: getGithubDisplayName() };
    existing.umans = {
      loggedIn: !!getUmansConfig().appSession || _umansState.loggedIn,
      email: getUmansConfig().email || _umansState.email,
      password: getUmansConfig().password || "",
      keys: getUmansConfig().keys,
      enabledModels: getUmansConfig().enabledModels,
      currentKeyIndex: getUmansCurrentKeyIndex(),
      userId: _umansState.userId || null,
      visionHandoffEnabled: getUmansVisionHandoff().enabled,
      visionHandoffModel: getUmansVisionHandoff().model,
      visionHandoffPrompt: getUmansVisionHandoff().prompt,
    };
    try {
      const allIds = getModelIds();
      if (allIds.length > 0) {
        const dm: Record<string, string[]> = {};
        for (const id of allIds) {
          if (_modelStates[id] === false) {
            const tag = getModelProviderTag(id);
            if (!dm[tag]) dm[tag] = [];
            dm[tag].push(id);
          }
        }
        existing.disabledModels = dm;
      }
    } catch (e: any) { console.log(`[CONFIG] disabledModels rebuild failed: ${e?.message}`); }
    writeFileSync(p, JSON.stringify(existing, null, 2));
    console.log(`[CONFIG] saved to ${p} (providers: ${_activeProviders.join(",")})`);
  } catch (e: any) {
    console.log(`[CONFIG] saveConfig failed: ${e?.message}`);
  }
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

function getStartedAt(): string {
  return DASHBOARD_START_TIME;
}

function toSmallCaps(s: string): string {
  const sc: Record<string, string> = {
    a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ғ", g: "ɢ", h: "ʜ", i: "ɪ",
    j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
    s: "s", t: "ᴛ", u: "ᴜ", v: "v", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  };
  return s.split("").map(c => sc[c.toLowerCase()] || c).join("");
}

function getDisplayNameOverride(id: string): string | null {
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = readJsonSync(p);
      if (c.modelDisplayNames && c.modelDisplayNames[id]) return c.modelDisplayNames[id];
    }
  } catch {}
  return null;
}

function formatModelName(id: string): string {
  const override = getDisplayNameOverride(id);
  if (override) return override;
  if (id.startsWith("umans-")) {
    const name = getUmansModelDisplayName(id);
    return name;
  }
  const isFreebuff = id.startsWith("freebuff/");
  const limTag = isFreebuff && getFreebuffModelPremium(id) ? " [LIM]" : "";
  const parts = getModelDisplayName(id.includes("/") ? id.split("/").pop() || id : id);
  const l = id.toLowerCase();
  const hasThinking = !isFreebuff && (l.includes("deepseek-v4") || (l.includes("mimo") && !l.includes("glm") && !l.includes("kimi") && !l.includes("minimax") && !l.includes("qwen")));
  if (!hasThinking) return `${limTag} ${parts}`.trim();
  const modes = l.includes("deepseek-v4") ? ["low", "medium", "high", "max"] : ["low", "medium", "high"];
  const tagMap: Record<string, string> = { low: toSmallCaps("lo"), medium: toSmallCaps("md"), high: toSmallCaps("hi"), max: toSmallCaps("mx") };
  return `💡 ${parts} [${modes.map(m => tagMap[m] || m).join(", ")}]`;
}

function getAgnesModels(): any[] {
  const modelIds = getModelIds();
  return modelIds.map((id: string) => {
    const isFreebuff = id.startsWith("freebuff/");
    const isAgnes = id.startsWith("agnes");
    const isCodestral = id.startsWith("codestral/");
    const family = getModelFamily(id);
    const providerTag = getModelProviderTag(id);
    return {
      id, name: formatModelName(id),
      family: family || (isFreebuff ? "freebuff" : isAgnes ? "agnes" : isCodestral ? "codestral" : "unknown"),
      providerTag,
      enabled: _modelStates[id] !== false,
      free: isFreebuff, locked: false,
    };
  });
}

function getModels(): any[] {
  const apiIds = getModelIds();
  const modelIds = [...new Set([...apiIds])];
  const hasAgnes = !!_agnesApiKey;

  const activeTags = activeModelTags();
  return modelIds.filter((id: string) => activeTags.has(getModelProviderTag(id))).map((id: string) => {
    const isFreebuff = id.startsWith("freebuff/");
    const isAgnes = id.startsWith("agnes");
    const family = getModelFamily(id);
    const providerTag = getModelProviderTag(id);
    const needsKey = isAgnes ? !hasAgnes : false;
    return {
      id, name: formatModelName(id),
      family: family || (isFreebuff ? "freebuff" : isAgnes ? "agnes" : "unknown"),
      providerTag,
      enabled: _modelStates[id] !== false,
      free: isFreebuff, locked: needsKey,
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
  if (pathname === "/dashboard") {
    let html = getDashboardHtml();
    // Inject wallpaper as inline base64 <style> into </head> (like UMANS-PROXY)
    const wpMode = _wallpaperSource;
    let wpStyle = "";
    if (wpMode === "bing" || wpMode === "wallhaven" || wpMode === "ai") {
      const cachePath = join(getCacheDir(), wpMode === "bing" ? "wallpaper-bing.jpg" : wpMode === "wallhaven" ? "wallpaper-haven.jpg" : "wallpaper-freegen.jpg");
      if (existsSync(cachePath)) {
        const imgBuf = readFileSync(cachePath);
        wpStyle = `<style>body{background:url(data:image/jpeg;base64,${imgBuf.toString("base64")}) center/cover no-repeat fixed !important}</style>`;
      }
    } else {
      wpStyle = "<style>body{background:black !important}</style>";
    }
    // Set data-wp-mode on <body> for client-side awareness
    html = html.replace("<body>", `<body data-wp-mode="${wpMode}">`);
    if (wpStyle) html = html.replace("</head>", wpStyle + "</head>");
    // Refresh stale Bing/wallhaven/AI wallpaper in background (never block page load on AI generation)
    if (wpMode === "bing" || wpMode === "wallhaven") {
      ensureWallpaperCached(wpMode).catch(() => {});
    } else if (wpMode === "ai") {
      freegenBackgroundRefresh();
    }
    return {
      handled: true,
      response: {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "connection": "close", "access-control-allow-origin": "*", "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net;" },
        body: Buffer.from(html),
      },
    };
  }

  // Serve wallpaper image (like UMANS-PROXY /api/bg)
  if (pathname === "/api/bg" && method === "GET") {
    let mode = _wallpaperSource || "none";
    if (mode === "none") {
      return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
    }
    const cacheDir = getCacheDir();
    if (mode === "ai") {
      const aiFile = join(cacheDir, "wallpaper-freegen.jpg");
      if (existsSync(aiFile)) {
        const imgData = readFileSync(aiFile);
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
      }
      try {
        await generateFreegenWallpaperToDisk();
        if (existsSync(aiFile)) {
          const imgData = readFileSync(aiFile);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
        }
      } catch {}
      return { handled: true, response: { statusCode: 500, headers: { "content-type": "text/plain", "connection": "close", "access-control-allow-origin": "*" }, body: Buffer.from("generation failed") } };
    }
    if (mode === "bing") {
      const cachePath = join(cacheDir, "wallpaper-bing.jpg");
      if (existsSync(cachePath)) {
        const imgData = readFileSync(cachePath);
        const stale = Date.now() - statSync(cachePath).mtimeMs > 60 * 60 * 1000;
        if (stale) fetchBingWallpaper().catch(() => {});
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
      }
      await fetchBingWallpaper().catch(() => {});
      if (existsSync(cachePath)) {
        const imgData = readFileSync(cachePath);
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
      }
      return { handled: true, response: { statusCode: 404, headers: { "content-type": "text/plain", "connection": "close", "access-control-allow-origin": "*" }, body: Buffer.from("not found") } };
    }
    if (mode === "wallhaven") {
      const cachePath = join(cacheDir, "wallpaper-haven.jpg");
      if (existsSync(cachePath)) {
        const imgData = readFileSync(cachePath);
        const stale = Date.now() - statSync(cachePath).mtimeMs > 60 * 60 * 1000;
        if (stale) fetchWallhavenWallpaper().catch(() => {});
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
      }
      await fetchWallhavenWallpaper().catch(() => {});
      if (existsSync(cachePath)) {
        const imgData = readFileSync(cachePath);
        return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
      }
      return { handled: true, response: { statusCode: 404, headers: { "content-type": "text/plain", "connection": "close", "access-control-allow-origin": "*" }, body: Buffer.from("not found") } };
    }
    return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
  }

  // Wallpaper generation progress
  if (pathname === "/api/wallpaper-progress" && method === "GET") {
    return { handled: true, response: jsonResponse(_genProgress) };
  }

  // Single initial-load endpoint — returns full config + status snapshot
  if (pathname === "/api/init" && method === "GET") {
    const snap = takeSnapshot();
    return { handled: true, response: jsonResponse(snap) };
  }

  // i18n API — autotranslation support
  if (pathname === "/api/i18n" && method === "GET") {
    const urlObj = new URL(req.url, "http://localhost");
    const hasKey = !!getUmansTranslationKey();
    if (urlObj.searchParams.get("config") === "1") {
      const nav = getDashboardLocale(urlObj);
      const forced = getForcedLocale();
      const fallbackLocale = forced || (hasKey ? nav || "en" : "en");
      return { handled: true, response: jsonResponse({ has_key: hasKey, forced_locale: forced, fallback_locale: fallbackLocale }) };
    }
    const locale = getDashboardLocale(urlObj);
    const forced = getForcedLocale();
    if (!hasKey || locale === "en") {
      const bundle = buildI18nBundle("en");
      return { handled: true, response: jsonResponse({ ...bundle, has_key: hasKey, forced_locale: forced, fallback_locale: "en" }) };
    }
    if (urlObj.searchParams.get("generate") === "1") {
      const bundle = await ensureI18nForLocale(locale);
      return { handled: true, response: jsonResponse({ ...bundle, has_key: true, forced_locale: forced, fallback_locale: locale }) };
    } else {
      const bundle = buildI18nBundle(locale);
      return { handled: true, response: jsonResponse({ ...bundle, has_key: true, forced_locale: forced, fallback_locale: locale }) };
    }
  }

  return { handled: false };
}

let _umansUsageCache: any = null;
let _umansUsageCacheTime = 0;
let _umansUsageHistoryCache: any = null;
let _umansUsageHistoryCacheTime = 0;
const UMANS_USAGE_CACHE_TTL = 60 * 1000;

export function incrementRequests() { _requestCount++; }

function obfuscateEmail(email: string): string {
  if (!email || !email.includes("@")) return email || "";
  const [user, domain] = email.split("@");
  const dParts = domain.split(".");
  const maskedDomain = dParts.map(p => p[0] + "*".repeat(Math.max(0, p.length - 1))).join(".");
  return user[0] + "*".repeat(user.length - 1) + "@" + maskedDomain;
}

export function getAgnesApiKey(): string {
  return _agnesApiKey;
}
