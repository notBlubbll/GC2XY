// Dashboard handler — serves web dashboard HTML + JSON API endpoints
// Always intercepted (even in proxy mode) at /dashboard and /api/* paths
// Status/data pushes to WebSocket clients on change only (delta-based)

import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";

const DASHBOARD_START_TIME = new Date().toISOString();
import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { HandlerInput, HandlerResult, jsonResponse, getProjectRoot, getMode, setMode, killPortProcess } from "../shared.ts";
import { setGithubSku, setGithubUsername, setGithubDisplayName, getGithubSku, getGithubUsername, getGithubDisplayName } from "../shared.ts";
import { getModelIds as getOcModelIds, getModelFamily, getModelDisplayName, getModelProviderTag, chatCompletion, setKeys as setOcKeys } from "./opencode-client.ts";
import { getFreebuffModelIds, getFreebuffModelPremium, chatCompletion as freebuffChat } from "./freebuff-client.ts";
import { getModelIds as getPollModelIds, chatCompletion as pollChat } from "./pollinations-client.ts";
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
  onUmansLoginStateChange,
} from "./umans-client.ts";
import { getModelIds } from "../models.ts";
import { getTps, restoreTerminal, setEnabledModelIds } from "../split-console.ts";
import { fetchAllWorkspacesWithKeysAndUsage, WorkspaceWithKeys } from "../opencode-workspace.ts";
import { ensureI18nForLocale, buildI18nBundle, getDashboardLocale, setUmansTranslationApiKey } from "../i18n.ts";

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
  const ocKeys = _keys;
  // Group models by provider tag
  const grouped: Record<string, any[]> = {};
  for (const m of models) {
    const pt = (m as any).providerTag || "go";
    if (!grouped[pt]) grouped[pt] = [];
    grouped[pt].push({ id: m.id, name: m.name, family: m.family, providerTag: pt, enabled: m.enabled !== false, free: !!m.free, locked: !!m.locked });
  }
  return {
    status: {
      mode: getMode().toUpperCase(),
      requests: _requestCount,
      tps: getTps(),
      hasValidKey: _hasValidKey,
      modelCount: models.length,
      enabledModelCount: models.filter((m: any) => m.enabled !== false).length,
      workDir: getProjectRoot(),
      port: process.env.gc2xy_HTTP_PORT || (process.env.IIS_PROXY === "1" ? "3080" : "80"),
      startedAt: getStartedAt(),
    },
    providers: _activeProviders,
    models: models.map(m => ({ id: m.id, name: m.name, family: m.family, providerTag: (m as any).providerTag || "go", enabled: m.enabled !== false, free: !!m.free, locked: !!m.locked })),
    groupedModels: grouped,
    keys: {
      opencode: ocKeys.map(k => ({ name: k.name, key: k.key, session: !!k.session, valid: _validKeys.has(k.key) })),
    },
    health: { status: _hasValidKey ? "ok" : "degraded", runtime: getRuntime(), platform: process.platform },
    wallpaper: _wallpaperSource,
    wallpaperPrompt: _wallpaperPrompt,
    agnesKey: _agnesApiKey ? `${_agnesApiKey.slice(0, 5)}...${_agnesApiKey.slice(-4)}` : "",
    hasAgnesKey: !!_agnesApiKey,
    completionsModel: _completionsModel,
    supermaven: (() => {
      const st = getSupermavenStatus();
      return { enabled: _supermavenEnabled, initialized: st.initialized, binaryPath: st.binaryPath };
    })(),
    openrouterKey: _openRouterApiKey ? `${_openRouterApiKey.slice(0, 5)}...${_openRouterApiKey.slice(-4)}` : "",
    hasOpenRouterKey: !!_openRouterApiKey,
    codestralKey: _codestralApiKey ? `${_codestralApiKey.slice(0, 5)}...${_codestralApiKey.slice(-4)}` : "",
    hasCodestralKey: !!_codestralApiKey,
    pollKey: _pollApiKey ? `${_pollApiKey.slice(0, 5)}...${_pollApiKey.slice(-4)}` : "",
    hasPollKey: !!_pollApiKey,
    wallpaperProgress: _genProgress,
    githubSettings: {
      skuMode: getGithubSku(),
      username: getGithubUsername(),
      displayName: getGithubDisplayName(),
    },
    sessionCookie: {
      opencode: _ocSessionCookie ? `${_ocSessionCookie.slice(0, 12)}...${_ocSessionCookie.slice(-4)}` : "",
      opencodeFull: _ocSessionCookie || "",
    },
    workspaceData: _workspaceData.map(ws => ({
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      usage: ws.usage,
      keyNames: ws.keyNames.map(kn => ({ keyID: kn.keyID, name: kn.name })),
      enabledKeyIDs: _workspaceKeyStates[ws.id] || [],
    })),
    umans: _umansState,
    umansUsage: _umansUsageCache,
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
export function startWsPushLoop() { if (!_pushTimer) _pushTimer = setInterval(() => pushStatusToWs(), 2000); }
export function stopWsPushLoop() { if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; } }

async function handleWsMessage(ws: WebSocket, msg: any) {
  const { action, payload } = msg;
  switch (action) {
    case "setMode": {
      if (payload?.mode) setMode(payload.mode.toLowerCase());
      pushStatusToWs();
      break;
    }
    case "toggleWorkspaceKey": {
      if (payload?.workspaceId && payload?.keyID && payload?.enabled !== undefined) {
        const wsId = payload.workspaceId;
        const keyID = payload.keyID;
        if (!_workspaceKeyStates[wsId]) _workspaceKeyStates[wsId] = [];
        const states = _workspaceKeyStates[wsId];
        if (payload.enabled) {
          if (!states.includes(keyID)) states.push(keyID);
        } else {
          const idx = states.indexOf(keyID);
          if (idx !== -1) states.splice(idx, 1);
        }
        _workspaceKeyStates[wsId] = states;
        saveConfig();
        syncKeysFromWorkspaceStates();
        validateOpencodeKeys().catch(() => {});
      }
      pushStatusToWs();
      break;
    }
    case "toggleModel": {
      if (payload?.modelId && payload?.enabled !== undefined) _modelStates[payload.modelId] = payload.enabled;
      saveConfig();
      _pushModelStatesToConsole();
      pushStatusToWs();
      break;
    }
    case "batchModelStates": {
      if (payload?.states) { _modelStates = { ..._modelStates, ...payload.states }; _pushModelStatesToConsole(); }
      pushStatusToWs();
      break;
    }
    case "addKey": {
      _keys.push({ name: payload?.name || `Key ${_keys.length + 1}`, key: payload?.key || "", session: payload?.session || "" });
      saveConfig();
      _workspaceData = [];
      _workspaceDataTime = 0;
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "updateKey": {
      if (typeof payload?.index === "number" && _keys[payload.index]) {
        if (payload.name !== undefined) _keys[payload.index].name = payload.name;
        if (payload.key !== undefined) _keys[payload.index].key = payload.key;
        if (payload.session !== undefined) _keys[payload.index].session = payload.session;
        saveConfig();
        _workspaceData = [];
        _workspaceDataTime = 0;
      }
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "deleteKey": {
      if (typeof payload?.index === "number" && _keys[payload.index]) { _keys.splice(payload.index, 1); saveConfig(); }
      _workspaceData = [];
      _workspaceDataTime = 0;
      validateOpencodeKeys().catch(() => {});
      pushStatusToWs();
      break;
    }
    case "setOcSession": {
      if (payload?.sessionCookie) {
        _ocSessionCookie = payload.sessionCookie;
        for (const k of _keys) { if (!k.session) k.session = payload.sessionCookie; }
        saveConfig();
        _workspaceData = [];
      }
      pushStatusToWs();
      break;
    }
    case "clearOcSession": {
      _ocSessionCookie = "";
      saveConfig();
      _workspaceData = [];
      pushStatusToWs();
      break;
    }
    case "validateKeys": {
      await validateOpencodeKeys();
      pushStatusToWs();
      break;
    }
    case "getWorkspaceUsage": {
      try {
        const result = await getWorkspaceUsage();
        ws.send(JSON.stringify({ type: "workspaceUsage", data: { cached: result.cached, data: result.data.map(ws => ({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          usage: ws.usage,
          keyNames: ws.keyNames,
          enabledKeyIDs: _workspaceKeyStates[ws.id] || [],
        })) } }));
      } catch { ws.send(JSON.stringify({ type: "workspaceUsage", data: { cached: false, data: [] } })); }
      break;
    }
    case "setWallpaper": {
      if (payload?.source) {
        if (payload.source === "ai" && !_agnesApiKey) {
          _wallpaperSource = "none";
          saveConfig();
          broadcastProgress();
          const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: "none" } });
          for (const client of _wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
          }
          break;
        }
        _wallpaperSource = payload.source;
        if (payload.prompt !== undefined && payload.prompt !== _wallpaperPrompt) {
          _wallpaperPrompt = payload.prompt;
          try { unlinkSync(join(getCacheDir(), "ai-paper.jpg")); } catch {}
        }
        saveConfig();
        if (_wallpaperSource === "ai") {
          generateAiWallpaperToDisk().then(() => {
            const msg2 = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
            for (const client of _wsClients) {
              if (client.readyState === WebSocket.OPEN) client.send(msg2);
            }
            sendWallpaperData();
          }).catch(() => {});
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
    case "getBingBg": {
      if (payload?.source) _wallpaperSource = payload.source;
      if (_wallpaperSource !== "none") {
        ensureWallpaperCached(_wallpaperSource).then(() => {
          sendWallpaperData(ws);
        }).catch(() => {});
      }
      if (_wallpaperSource === "ai") {
        generateAiWallpaperToDisk().then(() => {
          const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
          ws.send(msg);
          sendWallpaperData(ws);
        }).catch(() => {});
      }
      const msg = JSON.stringify({ type: "wallpaperUpdated", data: { source: _wallpaperSource, prompt: _wallpaperPrompt } });
      ws.send(msg);
      sendWallpaperData(ws);
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
        saveConfig();
        validateOpencodeKeys().catch(() => {});
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
      if (!_agnesApiKey && _wallpaperSource === "ai") {
        _wallpaperSource = "none";
      }
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "setOpenRouterKey": {
      _openRouterApiKey = payload?.key || "";
      if (_openRouterApiKey && _activeProviders.indexOf("openrouter") === -1) {
        _activeProviders.push("openrouter");
      } else if (!_openRouterApiKey) {
        const idx = _activeProviders.indexOf("openrouter");
        if (idx !== -1) _activeProviders.splice(idx, 1);
      }
      saveConfig();
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
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "setPollKey": {
      _pollApiKey = payload?.key || "";
      if (_pollApiKey && _activeProviders.indexOf("poll") === -1) {
        _activeProviders.push("poll");
      } else if (!_pollApiKey) {
        const idx = _activeProviders.indexOf("poll");
        if (idx !== -1) _activeProviders.splice(idx, 1);
      }
      saveConfig();
      pushStatusToWs();
      break;
    }
    case "renameModel": {
      try {
        const modelId = payload?.modelId;
        const displayName = payload?.displayName;
        if (modelId) {
          if (displayName) {
            const { setDisplayNameOverride } = await import("./opencode-client.ts");
            setDisplayNameOverride(modelId, displayName);
          } else {
            const { setDisplayNameOverride } = await import("./opencode-client.ts");
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
          const { setDisplayNameOverride } = await import("./opencode-client.ts");
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
      const valid = ["umans", "opencode", "zen", "freebuff", "agnes", "poll", "openrouter", "bitnet", "codestral", "deepseek"];
      if (Array.isArray(payload?.providers)) {
        const wasOc = _activeProviders.indexOf("opencode") !== -1;
        let requested = payload.providers.filter((p: string) => valid.includes(p));
        const wantsOc = requested.indexOf("opencode") !== -1;
        if (wantsOc && _keys.length === 0) {
          requested = requested.filter((p: string) => p !== "opencode");
        } else if (!wantsOc && wasOc) {
          for (const ws of _workspaceData) _workspaceKeyStates[ws.id] = [];
          setOcKeys([]);
        }
        _activeProviders = requested;
        saveConfig();
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
        const stream: boolean = payload?.stream === true;
        const reqId = payload?._id;
        if (!model || !Array.isArray(messages)) {
          ws.send(JSON.stringify({ type: "testChatResult", data: { error: "Invalid request" }, _id: reqId }));
          break;
        }
        const provider = model.startsWith("pol/") ? "poll" : model.startsWith("freebuff/") ? "freebuff" : model.startsWith("agnes") ? "agnes" : model.startsWith("codestral/") ? "codestral" : (model.startsWith("bitnet/") || model === "bitnet-demo") ? "bitnet" : "go";
        let resp: Response;
        if (provider === "poll") resp = await pollChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "freebuff") resp = await freebuffChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "agnes") resp = await agnesChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "codestral") resp = await codestralChat(model, messages, undefined, stream, { max_tokens: 2048 });
        else if (provider === "bitnet") resp = await bitnetChat(model, messages, undefined, stream);
        else resp = await chatCompletion(model, messages, undefined, stream, { max_tokens: 2048 });

        if (stream && resp.ok && resp.body) {
          let rawSse = "";
          const decoder = new TextDecoder();
          for await (const chunk of resp.body as any) { rawSse += decoder.decode(chunk, { stream: true }); }
          const data = await summarizeSseTestChat(rawSse, model);
          ws.send(JSON.stringify({ type: "testChatResult", data, _id: reqId }));
        } else if (!resp.ok) {
          const err: any = await resp.json().catch(() => ({}));
          ws.send(JSON.stringify({ type: "testChatResult", data: { error: err?.error?.message || err?.error || `HTTP ${resp.status}` }, _id: reqId }));
        } else {
          const data: any = await resp.json();
          const content = data?.choices?.[0]?.message?.content;
          if (!content) console.log(`[TEST CHAT] empty content from ${model}:`, JSON.stringify(data).slice(0, 500));
          ws.send(JSON.stringify({ type: "testChatResult", data, _id: reqId }));
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
          };
          syncUmansTranslationKey();
          saveConfig();
          broadcastUmansState();
          broadcastUmansUsage(state.usage);
          broadcastUmansConcurrency(concurrency);
          ws.send(JSON.stringify({ type: "umansUsageHistory", data: usageHistory }));
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
      _umansState = { loggedIn: false, email: "", keys: [], currentKeyIndex: 0, enabledModels: _umansState.enabledModels || [] };
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
      try {
        const keys = await fetchKeysFromApp();
        _umansState.keys = keys;
        syncUmansTranslationKey();
        saveConfig();
        broadcastUmansState();
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
        broadcastUmansUsage(usage);
        broadcastUmansConcurrency(concurrency);
        ws.send(JSON.stringify({ type: "umansUsageHistory", data: history }));
      } catch {}
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

const PROVIDER_TAG_MAP: Record<string, string> = { opencode: "go", zen: "zen", freebuff: "freebuff", agnes: "agnes", codestral: "codestral", bitnet: "bitnet", deepseek: "deepseek", umans: "umans" };

function syncUmansTranslationKey() {
  const cfg = getUmansConfig();
  const key = (cfg.keys || []).find(k => k.key)?.key || "";
  setUmansTranslationApiKey(key);
}

let _requestCount = 0;

let _modelStates: Record<string, boolean> = {};

function _pushModelStatesToConsole() {
  const modelIds = getModelIds();

  const activeTags = new Set(_activeProviders.map(p => PROVIDER_TAG_MAP[p] || p));
  const enabled = new Set(modelIds.filter(id => {
    if (!activeTags.has(getModelProviderTag(id))) return false;
    if (getModelProviderTag(id) === "featherless") return _modelStates[id] === true;
    return _modelStates[id] !== false;
  }));
  setEnabledModelIds(enabled);
}
let _validKeys = new Set<string>();
let _hasValidKey = false;
let _keyBalances: Record<string, any> = {};

let _keys: { name: string; key: string; session: string }[] = [];
let _ocSessionCookie = "";
let _dashboardCache: any = {};
let _dashboardCacheTime = 0;
const DASHBOARD_CACHE_TTL = 30000;

let _wallpaperSource = "none";
let _wallpaperPrompt = "";

let _agnesApiKey = "";

let _openRouterApiKey = "";

let _codestralApiKey = "";

let _pollApiKey = "";

let _aiWallpaperGen = false;
let _aiWallpaperGenPromise: Promise<boolean> | null = null;

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
let _activeProviders: string[] = ["opencode"]; // ["opencode", "zen", "freebuff", "agnes"]
let _completionsModel: string = "mistral-latest";
export function getCompletionsModel(): string { return _completionsModel; }
let _supermavenEnabled = false;

let _workspaceKeyStates: Record<string, string[]> = {};
let _workspaceData: WorkspaceWithKeys[] = [];
let _umansState: any = { loggedIn: false, email: "", keys: [], currentKeyIndex: 0, enabledModels: [] };

let _dashboardConfig: Record<string, any> = {
  mode: "mock",
  httpPort: 80,
  iisProxy: false,
  keys: [],
  models: [],
  wallpaper: "none",
  agnesKey: "",
  openrouterKey: "",
  providers: ["opencode"],
};

// ── Wallpaper source and caching ──
function getCacheDir(): string {
  const d = join(getProjectRoot(), ".cache");
  if (!existsSync(d)) try { writeFileSync(join(d, ".gitkeep"), ""); } catch {}
  return d;
}

function downloadInsecure(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "gc2xy/3.0" }, rejectUnauthorized: false }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        return reject(new Error(`download ${res.statusCode}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(new Error("download timeout")); });
  });
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

async function generateAiWallpaperToDisk(): Promise<boolean> {
  if (_aiWallpaperGen) {
    if (_aiWallpaperGenPromise) await _aiWallpaperGenPromise;
    return existsSync(join(getCacheDir(), "ai-paper.jpg"));
  }
  _aiWallpaperGen = true;
  setGenProgress("image", 0);
  _aiWallpaperGenPromise = (async () => {
    let errMsg = "";
    try {
      const cachePath = join(getCacheDir(), "ai-paper.jpg");
      const apiKey = _agnesApiKey;
      if (!apiKey) throw new Error("no Agnes API key configured");

      const prompt = _wallpaperPrompt || "hdr, polar night, vibrant rainbow colors, trees, mountains, glaciers, stars and dark skies";
      const body = JSON.stringify({
        model: "agnes-image-2.1-flash",
        prompt,
        n: 1,
        size: "1024x768",
        seed: Date.now(),
      });
      const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "gc2xy/3.0",
      };

      let data: any = null;
      let lastError: Error | null = null;
      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const resp = await fetch("https://apihub.agnes-ai.com/v1/images/generations", {
            method: "POST", headers, body, signal: AbortSignal.timeout(60000),
          });
          if (resp.ok) { data = await resp.json(); lastError = null; break; }
          const errBody = await resp.text();
          lastError = new Error(`upstream ${resp.status}: ${errBody.slice(0, 300)}`);
          const retryable = resp.status === 429 || resp.status >= 500;
          console.log(`[AI WALLPAPER] attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);
          if (!retryable || attempt === MAX_RETRIES) throw lastError;
          await new Promise(r => setTimeout(r, 2000 * attempt));
        } catch (e: any) {
          if (data) break;
          lastError = e;
          if (attempt < MAX_RETRIES) {
            const delay = 2000 * attempt;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (!data) throw lastError || new Error("upstream failed");

      let imageUrl = "";
      let b64Data = "";
      if (data.data && Array.isArray(data.data) && data.data[0]) {
        const item = data.data[0];
        if (item.url) imageUrl = item.url;
        else if (item.b64_json) b64Data = item.b64_json;
      }

      if (b64Data) {
        writeFileSync(cachePath, Buffer.from(b64Data, "base64"));
      } else if (imageUrl) {
        try {
          const buf = await downloadInsecure(imageUrl);
          writeFileSync(cachePath, buf);
        } catch (dlErr: any) {
          console.log("[AI WALLPAPER] CDN download failed, falling back to Bing:", dlErr.message);
          const bingOk = await fetchBingWallpaper();
          if (!bingOk) throw new Error("Agnes CDN unreachable and Bing fallback failed: " + dlErr.message);
          const bingBuf = readFileSync(join(getCacheDir(), "wallpaper-bing.jpg"));
          writeFileSync(cachePath, bingBuf);
          const fbMsg = JSON.stringify({ type: "wallpaperFallback", data: { reason: dlErr.message || "Agnes CDN unreachable" } });
          for (const client of _wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(fbMsg);
          }
        }
      } else {
        throw new Error("no image in response");
      }
      console.log("[AI WALLPAPER] generated", cachePath, Buffer.byteLength(b64Data ? Buffer.from(b64Data, "base64") : readFileSync(cachePath)), "bytes");
      return true;
    } catch (e: any) {
      errMsg = e?.message || String(e);
      console.log("[AI WALLPAPER] generation failed:", errMsg);
      return false;
    } finally {
      _aiWallpaperGen = false;
      _aiWallpaperGenPromise = null;
      if (!errMsg) {
        setGenProgress("image", 100);
      } else {
        const errMsg2 = JSON.stringify({ type: "wallpaperError", data: { message: errMsg } });
        for (const client of _wsClients) {
          if (client.readyState === WebSocket.OPEN) client.send(errMsg2);
        }
        if (_genResetTimer) { clearTimeout(_genResetTimer); _genResetTimer = null; }
        _genProgress = { kind: null, progress: 0 };
        broadcastProgress();
      }
    }
  })();
  return _aiWallpaperGenPromise;
}

async function fetchAiWallpaper(): Promise<boolean> {
  const cachePath = join(getCacheDir(), "ai-paper.jpg");
  const oneHour = 60 * 60 * 1000;
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < oneHour) return true;
  return generateAiWallpaperToDisk();
}

async function ensureWallpaperCached(source: string): Promise<boolean> {
  if (source === "bing") return fetchBingWallpaper();
  if (source === "wallhaven") return fetchWallhavenWallpaper();
  if (source === "ai") return fetchAiWallpaper();
  return false;
}

export function getWallpaperSource(): string { return _wallpaperSource; }

function getWallpaperPath(source: string): string {
  if (source === "bing") return join(getCacheDir(), "wallpaper-bing.jpg");
  if (source === "wallhaven") return join(getCacheDir(), "wallpaper-haven.jpg");
  if (source === "ai") return join(getCacheDir(), "ai-paper.jpg");
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

// Load keys from env
try {
  const envKeys = process.env.OPENCODE_API_KEYS;
  if (envKeys) {
    const parsed = JSON.parse(envKeys);
    if (Array.isArray(parsed)) {
      parsed.filter((k: string) => k.length > 5).forEach((k: string) => {
        _keys.push({ name: `Key ${k.slice(0, 8)}...`, key: k, session: "" });
      });
    }
  } else if (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.length > 5) {
    _keys.push({ name: "Primary Key", key: process.env.OPENCODE_API_KEY, session: "" });
  }
  const os = process.env.OPENCODE_SESSION;
  if (os && os.length > 5) {
    _ocSessionCookie = os;
  }
} catch (e) {}

// Load persisted keys from .config/config.json on startup
loadConfig();

// Start Supermaven client in background (don't block startup)
initSupermaven().catch((e: any) => console.log("[Supermaven] Init error:", e.message));

function loadConfig() {
  try {
    const p = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf-8"));
      if (c.OPENCODE_SESSION) _ocSessionCookie = c.OPENCODE_SESSION;
      if (c.KEYS && Array.isArray(c.KEYS)) {
        for (const t of c.KEYS) {
          if (t.key && !_keys.find(x => x.key === t.key)) {
            let name = t.name || "Key";
            if (name === "Default" || !name.trim()) {
              name = t.key.slice(0, 8) + "...";
            }
            _keys.push({ name, key: t.key, session: t.session || "" });
            if (t.session && !_ocSessionCookie) _ocSessionCookie = t.session;
          }
        }
      } else if (c.TOKENS && Array.isArray(c.TOKENS)) {
        for (const t of c.TOKENS) {
          const k = (t as any).token || (t as any).key;
          if (k && !_keys.find(x => x.key === k)) {
            let name = t.name || "Key";
            if (name === "Default" || !name.trim()) name = k.slice(0, 8) + "...";
            _keys.push({ name, key: k, session: t.session || "" });
            if (t.session && !_ocSessionCookie) _ocSessionCookie = t.session;
          }
        }
      }
      if (c.wallpaper) _wallpaperSource = c.wallpaper;
      if (c.wallpaperPrompt) _wallpaperPrompt = c.wallpaperPrompt;
      if (c.providers && Array.isArray(c.providers)) _activeProviders = c.providers;
      else if (c.provider) _activeProviders = [c.provider]; // migrate old single-value
      if (c.agnesKey) { _agnesApiKey = c.agnesKey; if (_activeProviders.indexOf("agnes") === -1) _activeProviders.push("agnes"); }
      if (c.openrouterKey) { _openRouterApiKey = c.openrouterKey; if (_activeProviders.indexOf("openrouter") === -1) _activeProviders.push("openrouter"); }
      if (c.codestralKey) { _codestralApiKey = c.codestralKey; if (_activeProviders.indexOf("codestral") === -1) _activeProviders.push("codestral"); }
      if (c.pollApiKey) { _pollApiKey = c.pollApiKey; if (_activeProviders.indexOf("poll") === -1) _activeProviders.push("poll"); }
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
      if (c.workspaceKeyStates && typeof c.workspaceKeyStates === "object") _workspaceKeyStates = c.workspaceKeyStates;
      if (c.umans) {
        _umansState = { ..._umansState, ...c.umans };
        if (c.umans.email) setUmansEmail(c.umans.email);
        if (c.umans.password) setUmansPassword(c.umans.password);
        if (c.umans.appSession) setUmansAppSession(c.umans.appSession);
        if (Array.isArray(c.umans.keys)) setUmansKeys(c.umans.keys);
        if (Array.isArray(c.umans.enabledModels)) setUmansEnabledModels(c.umans.enabledModels);
        if (typeof c.umans.currentKeyIndex === "number") setUmansCurrentKeyIndex(c.umans.currentKeyIndex);
        syncUmansTranslationKey();
      }
      if (c.disabledModels && typeof c.disabledModels === "object") {
        for (const [tag, ids] of Object.entries(c.disabledModels as Record<string, string[]>)) {
          if (Array.isArray(ids)) for (const id of ids) _modelStates[id as string] = false;
        }
      }
    }
  } catch {}
}

function saveConfig() {
  try {
    const dir = join(getProjectRoot(), ".config");
    if (!existsSync(dir)) try { writeFileSync(join(dir, ".gitkeep"), ""); } catch {}
    const p = join(dir, "config.json");
    const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
    existing.OPENCODE_SESSION = _ocSessionCookie;
    existing.KEYS = _keys;
    existing.workspaceKeyStates = _workspaceKeyStates;
    existing.wallpaper = _wallpaperSource;
    existing.wallpaperPrompt = _wallpaperPrompt;
    existing.agnesKey = _agnesApiKey;
    existing.openrouterKey = _openRouterApiKey;
    existing.codestralKey = _codestralApiKey;
    existing.pollApiKey = _pollApiKey;
    existing.providers = _activeProviders;
    existing.completionsModel = _completionsModel;
    existing.supermavenEnabled = _supermavenEnabled;
    existing.githubSettings = { skuMode: getGithubSku(), username: getGithubUsername(), displayName: getGithubDisplayName() };
    existing.umans = {
      loggedIn: !!getUmansConfig().appSession || _umansState.loggedIn,
      email: getUmansConfig().email || _umansState.email,
      password: getUmansConfig().password || "",
      keys: getUmansConfig().keys,
      enabledModels: getUmansConfig().enabledModels,
      currentKeyIndex: getUmansCurrentKeyIndex(),
    };
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
    writeFileSync(p, JSON.stringify(existing, null, 2));
  } catch {}
}

async function validateOpencodeKeys(): Promise<void> {
  _hasValidKey = false;
  _validKeys.clear();
  if (_keys.length === 0) return;
  let anyValid = false;
  for (const k of _keys) {
    try {
      const resp = await fetch("https://opencode.ai/zen/go/v1/models", {
        headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        _validKeys.add(k.key); anyValid = true;
        try {
          const balResp = await fetch("https://opencode.ai/zen/go/v1/dashboard/billing", {
            headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(3000),
          });
          if (balResp.ok) _keyBalances[k.key] = await balResp.json();
        } catch {}
      } else _validKeys.delete(k.key);
    } catch { _validKeys.delete(k.key); }
  }
  _hasValidKey = anyValid;
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
      const c = JSON.parse(readFileSync(p, "utf-8"));
      if (c.modelDisplayNames && c.modelDisplayNames[id]) return c.modelDisplayNames[id];
    }
  } catch {}
  return null;
}

function formatModelName(id: string): string {
  const override = getDisplayNameOverride(id);
  if (override) return override;
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

function getOcModels(): any[] {
  const modelIds = getModelIds();
  const canShowPremium = _hasValidKey;
  return modelIds.filter(id => getModelProviderTag(id) === "go").map((id: string) => {
    return {
      id, name: formatModelName(id),
      family: getModelFamily(id) || "unknown",
      providerTag: "go",
      enabled: canShowPremium ? (_modelStates[id] !== false) : false,
      free: false, locked: !canShowPremium,
    };
  });
}

function getOpenRouterModels(): any[] {
  const modelIds = getModelIds();
  const hasKey = !!_openRouterApiKey;
  return modelIds.filter(id => getModelProviderTag(id) === "openrouter").map((id: string) => {
    return {
      id, name: formatModelName(id),
      family: getModelFamily(id) || "openrouter",
      providerTag: "openrouter",
      enabled: hasKey && _modelStates[id] !== false,
      free: false, locked: !hasKey,
    };
  });
}

function getAgnesModels(): any[] {
  const modelIds = getModelIds();
  const hasKey = !!_agnesApiKey;
  const hasOpenRouter = !!_openRouterApiKey;
  const hasCodestral = !!_codestralApiKey;
  const canShowPremium = _hasValidKey;
  return modelIds.map((id: string) => {
    const isFree = id.startsWith("pol/") || id.startsWith("freebuff/");
    const isFreebuff = id.startsWith("freebuff/");
    const isAgnes = id.startsWith("agnes");
    const isOpenRouter = id.startsWith("openrouter/");
    const isCodestral = id.startsWith("codestral/");
    const family = getModelFamily(id);
    const providerTag = getModelProviderTag(id);
    return {
      id, name: formatModelName(id),
      family: family || (isOpenRouter ? "openrouter" : isFreebuff ? "freebuff" : isAgnes ? "agnes" : isCodestral ? "codestral" : isFree ? "pollinations" : "unknown"),
      providerTag,
      enabled: _modelStates[id] !== false,
      free: isFree, locked: false,
    };
  });
}

function getModels(): any[] {
  const apiIds = getModelIds();
  const modelIds = [...new Set([...apiIds])];
  const canShowPremium = _hasValidKey;
  const hasAgnes = !!_agnesApiKey;
  const hasOpenRouter = !!_openRouterApiKey;

  const activeTags = new Set(_activeProviders.map(p => {
    if (p === "opencode") return "go";
    if (p === "umans") return "umans";
    return p;
  }));
  return modelIds.filter((id: string) => activeTags.has(getModelProviderTag(id))).map((id: string) => {
    const isFree = id.startsWith("pol/") || id.startsWith("freebuff/");
    const isFreebuff = id.startsWith("freebuff/");
    const isFeatherless = id.startsWith("featherless/");
    const isAgnes = id.startsWith("agnes");
    const isOpenRouter = id.startsWith("openrouter/");
    const family = getModelFamily(id);
    const providerTag = getModelProviderTag(id);
    const needsKey = isOpenRouter ? !hasOpenRouter : isAgnes ? !hasAgnes : false;
    return {
      id, name: formatModelName(id),
      family: family || (isOpenRouter ? "openrouter" : isFreebuff ? "freebuff" : isFeatherless ? "featherless" : isAgnes ? "agnes" : isFree ? "pollinations" : "unknown"),
      providerTag,
      enabled: _modelStates[id] !== false,
      free: isFree, locked: needsKey || (!isFree && !canShowPremium),
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
    // Inject wallpaper as inline base64 <style> into </head> (like AGNES-PROXY)
    const wpMode = _wallpaperSource;
    let wpStyle = "";
    if (wpMode === "bing" || wpMode === "wallhaven" || wpMode === "ai") {
      await ensureWallpaperCached(wpMode);
      const cachePath = join(getCacheDir(), wpMode === "bing" ? "wallpaper-bing.jpg" : wpMode === "wallhaven" ? "wallpaper-haven.jpg" : "ai-paper.jpg");
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
    // Refresh stale Bing/wallhaven/AI wallpaper in background
    if (wpMode === "bing" || wpMode === "wallhaven" || wpMode === "ai") {
      ensureWallpaperCached(wpMode).catch(() => {});
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

  // Serve wallpaper image (like AGNES-PROXY /api/bg)
  if (pathname === "/api/bg" && method === "GET") {
    let mode = _wallpaperSource || "none";
    if (mode === "none") {
      return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
    }
    const cacheDir = getCacheDir();
    if (mode === "ai") {
      if (!_agnesApiKey) { mode = "bing"; }
      else {
        const aiFile = join(cacheDir, "ai-paper.jpg");
        if (existsSync(aiFile)) {
          const imgData = readFileSync(aiFile);
          return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
        }
        try {
          await generateAiWallpaperToDisk();
          if (existsSync(aiFile)) {
            const imgData = readFileSync(aiFile);
            return { handled: true, response: { statusCode: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-cache", "content-length": String(imgData.length), "connection": "close", "access-control-allow-origin": "*" }, body: imgData } };
          }
        } catch {}
        return { handled: true, response: { statusCode: 500, headers: { "content-type": "text/plain", "connection": "close", "access-control-allow-origin": "*" }, body: Buffer.from("generation failed") } };
      }
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

  // Export Agnes API key for external modules (used by opencode-client for routing)
  if (pathname === "/api/agnes-key" && method === "GET") {
    return { handled: true, response: jsonResponse({ key: _agnesApiKey }) };
  }

  // Single initial-load endpoint — returns full config + status snapshot
  if (pathname === "/api/init" && method === "GET") {
    if (_validKeys.size === 0 && _keys.length > 0) {
      await validateOpencodeKeys().catch(() => {});
    }
    const snap = takeSnapshot();
    return { handled: true, response: jsonResponse(snap) };
  }

  // i18n API — autotranslation support
  if (pathname === "/api/i18n" && method === "GET") {
    const urlObj = new URL(req.url, "http://localhost");
    const hasKey = !!getUmansTranslationKey();
    if (urlObj.searchParams.get("config") === "1") {
      const nav = getDashboardLocale(urlObj);
      const fallbackLocale = hasKey ? nav || "en" : "en";
      return { handled: true, response: jsonResponse({ has_key: hasKey, forced_locale: null, fallback_locale: fallbackLocale }) };
    }
    const locale = getDashboardLocale(urlObj);
    if (!hasKey || locale === "en") {
      const bundle = buildI18nBundle("en");
      return { handled: true, response: jsonResponse({ ...bundle, has_key: hasKey, forced_locale: null, fallback_locale: "en" }) };
    }
    if (urlObj.searchParams.get("generate") === "1") {
      const bundle = await ensureI18nForLocale(locale);
      return { handled: true, response: jsonResponse({ ...bundle, has_key: true, forced_locale: null, fallback_locale: locale }) };
    } else {
      const bundle = buildI18nBundle(locale);
      return { handled: true, response: jsonResponse({ ...bundle, has_key: true, forced_locale: null, fallback_locale: locale }) };
    }
  }

  return { handled: false };
}

// ── OpenCode Workspace Usage Cache ──
let _workspaceDataTime = 0;
const WORKSPACE_CACHE_TTL = 60 * 60 * 1000;
let _umansUsageCache: any = null;
let _umansUsageCacheTime = 0;
const UMANS_USAGE_CACHE_TTL = 60 * 1000;

async function fetchWorkspaceUsageData(): Promise<WorkspaceWithKeys[]> {
  const envSession = (process.env.OPENCODE_SESSION || "").trim();
  if (envSession && !_ocSessionCookie) _ocSessionCookie = envSession;
  const globalSession = _ocSessionCookie || "";
  if (!globalSession) return [];

  try {
    const ws = await fetchAllWorkspacesWithKeysAndUsage(globalSession);
    console.log(`[WS] workspace-centric: ${ws.length} workspaces`);
    _workspaceData = ws;
    syncKeysFromWorkspaceStates();
    saveConfig();
    return ws;
  } catch (e: any) {
    console.log(`[WS] workspace fetch failed - ${e.message}`);
    return _workspaceData;
  }
}

function syncKeysFromWorkspaceStates() {
  if (_workspaceData.length === 0) return;
  const newKeys: { name: string; key: string; session: string }[] = [];
  for (const ws of _workspaceData) {
    const hasExplicitState = ws.id in _workspaceKeyStates;
    const enabledIDs = _workspaceKeyStates[ws.id] || [];
    for (const kn of ws.keyNames) {
      const isEnabled = hasExplicitState ? enabledIDs.includes(kn.keyID) : true;
      if (isEnabled) {
        const existing = _keys.find(k => k.name === kn.name || k.key.endsWith(kn.keyID));
        if (existing && !newKeys.find(nk => nk.key === existing.key)) newKeys.push(existing);
      }
    }
  }
  _keys = newKeys;
  setOcKeys(newKeys.map(k => k.key));
  const hasOcKeys = newKeys.length > 0;
  const hasOcProvider = _activeProviders.indexOf("opencode") !== -1;
  if (hasOcKeys && !hasOcProvider) {
    _activeProviders.push("opencode");
  } else if (!hasOcKeys && hasOcProvider) {
    _activeProviders.splice(_activeProviders.indexOf("opencode"), 1);
  }
  saveConfig();
}

export function incrementRequests() { _requestCount++; }

function obfuscateEmail(email: string): string {
  if (!email || !email.includes("@")) return email || "";
  const [user, domain] = email.split("@");
  const dParts = domain.split(".");
  const maskedDomain = dParts.map(p => p[0] + "*".repeat(Math.max(0, p.length - 1))).join(".");
  return user[0] + "*".repeat(user.length - 1) + "@" + maskedDomain;
}

async function getWorkspaceUsage(): Promise<{ cached: boolean; data: WorkspaceWithKeys[] }> {
  const now = Date.now();
  if (_workspaceData.length > 0 && now - _workspaceDataTime < WORKSPACE_CACHE_TTL) {
    return { cached: true, data: _workspaceData };
  }
  try {
    const data = await fetchWorkspaceUsageData();
    _workspaceDataTime = now;
    return { cached: false, data };
  } catch {
    return { cached: true, data: _workspaceData };
  }
}

export function getSessionDebugInfo(): Record<string, any> {
  return {
    ocSessionCookie: _ocSessionCookie ? `${_ocSessionCookie.slice(0, 16)}...${_ocSessionCookie.slice(-8)}` : "(empty)",
    ocSessionCookieLen: _ocSessionCookie.length,
    opencodeKeys: _keys.map(k => ({
      name: k.name,
      hasSession: !!k.session,
      sessionPrefix: k.session ? k.session.slice(0, 10) + "..." : "",
    })),
    workspaceCacheEntries: _workspaceData.length,
    workspaceCacheTime: _workspaceDataTime,
  };
}

export function getAgnesApiKey(): string {
  return _agnesApiKey;
}

export function getOpenRouterApiKey(): string {
  return _openRouterApiKey;
}

export function filterModelsByConfig(modelIds: string[]): string[] {
  const PROVIDER_MAP: Record<string, string> = { opencode: "go", zen: "zen", freebuff: "freebuff", agnes: "agnes", codestral: "codestral", bitnet: "bitnet", deepseek: "deepseek", umans: "umans" };
  try {
    const cp = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(cp)) {
      const cfg = JSON.parse(readFileSync(cp, "utf-8"));
      const activeProviders: string[] = cfg.providers || ["umans"];
      const activeTags = new Set(activeProviders.map((pr: string) => PROVIDER_MAP[pr] || pr));
      let ids = modelIds.filter(id => activeTags.has(getModelProviderTag(id)));
      const dm: Record<string, string[]> = cfg.disabledModels || {};
      const disabledSet = new Set(Object.values(dm).flat() as string[]);
      ids = ids.filter(id => !disabledSet.has(id));
      return ids;
    }
  } catch {}
  return modelIds;
}
