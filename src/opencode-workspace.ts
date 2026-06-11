import * as crypto from "node:crypto";

export interface WorkspaceUsage {
  rollingUsage: { usagePercent: number; resetInSec: number } | null;
  weeklyUsage: { usagePercent: number; resetInSec: number } | null;
  monthlyUsage?: { usagePercent: number; resetInSec: number } | null;
  hasSubscription?: boolean;
  isLite?: boolean;
  totalTokens?: number;
  totalCost?: number;
  requestCount?: number;
  monthlyUsageRaw?: number;
  monthlyLimitRaw?: number | null;
  label?: string;
}

export interface WorkspaceWithUsage {
  id: string;
  name: string;
  slug: string;
  plan?: string;
  usage: WorkspaceUsage;
  fetchedAt: number;
}

export interface KeyWorkspaceData {
  keyPrefix: string;
  keyId: string;
  keyName: string;
  dataKey?: string;
  session: string;
  error?: string;
  workspaces: WorkspaceWithUsage[];
  workspaceKeyNames?: { keyID: string; name: string }[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const WORKSPACE_FN = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";

function fullCookie(raw: string): string {
  if (!raw.includes("=")) return `oc_locale=en; auth=${raw}`;
  if (raw.includes(";")) return raw;
  if (raw.startsWith("auth=")) return `oc_locale=en; ${raw}`;
  return raw;
}

async function checkSession(text: string): Promise<void> {
  if (text.includes("not associated with an account") || text.includes("/auth/authorize")) {
    throw new Error("session expired / needs auth");
  }
}

function extractAllScripts(html: string): string {
  const scripts: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  return scripts.join("\n");
}

export function extractKeyNames(html: string): Map<string, string> {
  const names = new Map<string, string>();
  const scripts = extractAllScripts(html);
  const blockRe = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(scripts)) !== null) {
    const b = block[0];
    const idMatch = b.match(/id\s*:\s*"(key_[^"]+)"/);
    const nameMatch = b.match(/name\s*:\s*"([^"]+)"/);
    if (idMatch && nameMatch && !names.has(idMatch[1])) {
      names.set(idMatch[1], nameMatch[1]);
    }
  }
  return names;
}

function extractWorkspacesFromServer(text: string): { id: string; name: string }[] {
  const workspaces: { id: string; name: string }[] = [];
  let m: RegExpExecArray | null;
  const wsRe = /\{id:"(wrk_[^"]*?)",name:"([^"]*?)"/g;
  while ((m = wsRe.exec(text)) !== null) {
    if (!workspaces.find(w => w.id === m![1])) workspaces.push({ id: m[1], name: m[2] });
  }
  if (workspaces.length === 0) {
    // Try alternate format
    const wsRe2 = /id\s*:\s*"(wrk_[^"]*?)"\s*,\s*name\s*:\s*"([^"]*?)"/g;
    while ((m = wsRe2.exec(text)) !== null) {
      if (!workspaces.find(w => w.id === m![1])) workspaces.push({ id: m[1], name: m[2] });
    }
  }
  return workspaces;
}

function extractAllWorkspaceNames(html: string): { id: string; name: string }[] {
  const names = new Map<string, string>();
  const re = /workspace(?:Id)?["\s:=]+(wrk_[^"'\s\}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (!names.has(id)) {
      const nameMatch = html.match(new RegExp(`(?:name|title)["\s:;]+${id}["\s,]`));
      names.set(id, id.slice(0, 20));
    }
  }
  return [...names.entries()].map(([id, name]) => ({ id, name }));
}

function extractSubField(scripts: string, field: string): { usagePercent: number; resetInSec: number } | null {
  const re = new RegExp(field + '\\s*:\\s*(?:\\$R\\[\\d+\\]=\\s*)?\\{([^}]*)\\}');
  const m = re.exec(scripts);
  if (!m) return null;
  const inner = m[1];
  const upMatch = inner.match(/usagePercent\s*:\s*([0-9.]+)/);
  const rsMatch = inner.match(/resetInSec\s*:\s*(\d+)/);
  if (!upMatch) return null;
  return {
    usagePercent: parseFloat(upMatch[1]),
    resetInSec: rsMatch ? parseInt(rsMatch[1]) : 0,
  };
}

function extractUsageFromScripts(scripts: string): WorkspaceUsage {
  const result: WorkspaceUsage = { rollingUsage: null, weeklyUsage: null, hasSubscription: false, isLite: false, totalTokens: 0, totalCost: 0, requestCount: 0 };

  const liteSubRaw = scripts.match(/liteSubscriptionID\s*:\s*(?:\$R\[\d+\]=)?"[^"]+"/);
  const hasLite = liteSubRaw !== null;
  result.isLite = hasLite;
  result.hasSubscription = hasLite;

  if (!hasLite) {
    result.label = 'no active go sub';
    return result;
  }

  result.rollingUsage = extractSubField(scripts, 'rollingUsage');
  result.weeklyUsage = extractSubField(scripts, 'weeklyUsage');
  result.monthlyUsage = extractSubField(scripts, 'monthlyUsage');

  const ru = result.rollingUsage;
  const wu = result.weeklyUsage;
  const mu = result.monthlyUsage;
  const hasAny = ru !== null || wu !== null || mu !== null;

  if (hasAny) {
    result.requestCount = 1;
    result.label = `active`;
  } else {
    result.label = 'active · no usage data yet';
  }

  return result;
}

export async function fetchWorkspaces(cookie: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch("https://opencode.ai/_server?id=" + encodeURIComponent(WORKSPACE_FN), {
    method: "GET",
    headers: {
      Cookie: fullCookie(cookie),
      "X-Server-Id": WORKSPACE_FN,
      "X-Server-Instance": `oc-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      "User-Agent": UA,
      Origin: "https://opencode.ai",
      Referer: "https://opencode.ai/",
      Accept: "application/json, text/javascript, */*;q=0.8",
    },
  });
  const text = await resp.text();
  await checkSession(text);
  const ws = extractWorkspacesFromServer(text);
  console.log(`[WS] _server returned ${ws.length} workspaces`);
  if (ws.length > 0) return ws;
  const rootResp = await fetch("https://opencode.ai/", {
    method: "GET",
    headers: {
      Cookie: fullCookie(cookie),
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const rootText = await rootResp.text();
  await checkSession(rootText);
  const rootWs = extractWorkspacesFromServer(extractAllScripts(rootText));
  console.log(`[WS] _server returned 0, root page returned ${rootWs.length}`);
  return rootWs;
}

export async function fetchWorkspacesWithEmail(cookie: string): Promise<{ workspaces: { id: string; name: string }[]; email: string | null }> {
  const resp = await fetch("https://opencode.ai/_server?id=" + encodeURIComponent(WORKSPACE_FN), {
    method: "GET", headers: { Cookie: fullCookie(cookie), "X-Server-Id": WORKSPACE_FN, "X-Server-Instance": `oc-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, "User-Agent": UA, Origin: "https://opencode.ai", Referer: "https://opencode.ai/", Accept: "text/javascript, application/json;q=0.9, */*;q=0.8" },
  });
  const text = await resp.text();
  await checkSession(text);
  const ws = extractWorkspacesFromServer(text);
  if (ws.length > 0) {
    let email: string | null = null;
    try {
      const wsResp = await fetch(`https://opencode.ai/workspace/${ws[0].id}/go`, {
        headers: { Cookie: fullCookie(cookie), "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
      const wsText = await wsResp.text();
      email = extractUserEmail(wsText);
      console.log(`[WS EMAIL] workspace page email=${email || "not found"}`);
    } catch (e) { console.log(`[WS EMAIL] workspace fetch failed: ${e.message}`); }
    console.log(`[WS] fetched ${ws.length} workspaces from _server, email=${email || "none"}`);
    return { workspaces: ws, email };
  }
  return { workspaces: [], email: null };
}

function extractUserEmail(text: string): string | null {
  const m = text.match(/"\$R\[(\d+)\]\([^,]+,\s*"([^"]*?@[^"]*?)"/);
  return m ? m[2] : null;
}

export async function fetchWorkspaceUsage(cookie: string, workspaceId: string): Promise<WorkspaceUsage> {
  const resp = await fetch(`https://opencode.ai/workspace/${workspaceId}/go`, {
    headers: {
      Cookie: fullCookie(cookie),
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const text = await resp.text();
  await checkSession(text);
  const scripts = extractAllScripts(text);
  const usage = extractUsageFromScripts(scripts);
  const hasData = usage.rollingUsage !== null || usage.weeklyUsage !== null || usage.monthlyUsage !== null;
  console.log(`[WS USAGE] ${workspaceId}: ${hasData ? `roll=${usage.rollingUsage?.usagePercent}% week=${usage.weeklyUsage?.usagePercent}% month=${usage.monthlyUsage?.usagePercent}%` : "no data found"}`);
  if (hasData) return usage;
  const rawUsage = extractUsageFromScripts(text);
  const hasRaw = rawUsage.rollingUsage !== null || rawUsage.weeklyUsage !== null || rawUsage.monthlyUsage !== null;
  console.log(`[WS USAGE] ${workspaceId} fallback raw: ${hasRaw ? "found" : "none"}`);
  return rawUsage;
}

/**
 * Master function: fetches all workspaces + their API keys using one shared session,
 * then matches each config key (by name) to its workspace and returns usage per key.
 */
export async function resolveAllKeysToWorkspaces(
  keys: { key: string; name: string; session: string }[],
  globalSession: string,
): Promise<KeyWorkspaceData[]> {
  const results: KeyWorkspaceData[] = [];

  // Build a map: workspace ID -> list of API key names in that workspace
  for (const k of keys) {
    const session = k.session || globalSession;
    const keyPrefix = k.key ? `${k.key.slice(0, 6)}...${k.key.slice(-4)}` : "none";
    const keyId = k.key ? k.key.slice(0, 8) : "none";
    const entry: KeyWorkspaceData = { keyPrefix, keyId, keyName: k.name, dataKey: k.key, session, workspaces: [] };

    if (!session) { entry.error = "no session cookie"; results.push(entry); continue; }

    try {
      const { workspaces } = await fetchWorkspacesWithEmail(session);
      if (!workspaces || workspaces.length === 0) { entry.error = "no workspaces"; results.push(entry); continue; }

      // Fetch key names for each workspace
      const wsKeyMap = new Map<string, { keyID: string; name: string }[]>();
      for (const ws of workspaces) {
        try {
          const ks = await fetchWorkspaceKeyNames(session, ws.id);
          wsKeyMap.set(ws.id, ks);
        } catch { wsKeyMap.set(ws.id, []); }
      }

      // Match: find which workspace contains a key name matching this config key's name
      let matchedWs: { id: string; name: string } | null = null;
      for (const ws of workspaces) {
        const keysInWs = wsKeyMap.get(ws.id) || [];
        const found = keysInWs.find(kws => kws.name.toLowerCase() === k.name.toLowerCase());
        if (found) { matchedWs = ws; break; }
      }

      const targetWs = matchedWs || workspaces[0];
      let usage: WorkspaceUsage;
      try { usage = await fetchWorkspaceUsage(session, targetWs.id); } catch { usage = { rollingUsage: null, weeklyUsage: null, monthlyUsage: null }; }

      entry.keyName = targetWs.name;
      entry.workspaces = [{ ...targetWs, usage, fetchedAt: Date.now() }];
      entry.workspaceKeyNames = wsKeyMap.get(targetWs.id);
      console.log(`[WS MATCH] key=${keyPrefix} name="${k.name}" → ${targetWs.name} (${targetWs.id}) ${matchedWs ? "(matched)" : "(fallback)"}`);
    } catch (e: any) { entry.error = e.message; }

    results.push(entry);
  }

  return results;
}

export async function getWorkspaceDataForKey(key: string, keyName: string, cookie: string): Promise<KeyWorkspaceData> {
  const keyPrefix = key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "none";
  const keyId = key ? key.slice(0, 8) : "none";
  const data: KeyWorkspaceData = { keyPrefix, keyId, keyName, dataKey: key, session: cookie, workspaces: [] };
  if (!cookie) { data.error = "no session cookie"; return data; }
  try {
    const { workspaces, email } = await fetchWorkspacesWithEmail(cookie);
    if (!workspaces || workspaces.length === 0) { data.error = "no workspaces found"; return data; }
    if (email) data.keyName = email;
    const keyNamesMap = await fetchAllWorkspaceKeyNames(cookie, workspaces.map(w => w.id));
    let matchedWs: { id: string; name: string } | null = null;
    for (const ws of workspaces) {
      const wsKeys = keyNamesMap.get(ws.id) || [];
      for (const kws of wsKeys) {
        if (kws.name === keyName) { matchedWs = ws; break; }
      }
      if (matchedWs) break;
    }
    const targetWs = matchedWs || workspaces[0];
    data.keyName = targetWs.name;
    let usage: WorkspaceUsage;
    try { usage = await fetchWorkspaceUsage(cookie, targetWs.id); } catch (e: any) { usage = { rollingUsage: null, weeklyUsage: null }; }
    data.workspaces = [{ ...targetWs, usage, fetchedAt: Date.now() }];
    console.log(`[WS MATCH] key=${keyPrefix} → ${targetWs.name} (${targetWs.id})`);
  } catch (e: any) { data.error = e?.message || "unknown error"; }
  return data;
}

export function extractKeyNamesFromHtml(html: string): { keyID: string; name: string }[] {
  const keys: { keyID: string; name: string }[] = [];
  const nameRe = /<td data-slot="key-name">([^<]+)<\/td>/g;
  const actionsRe = /name="id" value="(key_[^"]+)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(html)) !== null) names.push(m[1]);
  const ids: string[] = [];
  while ((m = actionsRe.exec(html)) !== null) ids.push(m[1]);
  for (let i = 0; i < Math.min(names.length, ids.length); i++) {
    keys.push({ keyID: ids[i], name: names[i] });
  }
  return keys;
}

let _cachedKeyNames: Map<string, { names: { keyID: string; name: string }[]; fetchedAt: number }> = new Map();
const KEY_NAMES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchWorkspaceKeyNames(cookie: string, workspaceId: string): Promise<{ keyID: string; name: string }[]> {
  const cacheKey = `${workspaceId}`;
  const cached = _cachedKeyNames.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < KEY_NAMES_CACHE_TTL) {
    return cached.names;
  }
  try {
    const resp = await fetch(`https://opencode.ai/workspace/${workspaceId}/keys`, {
      headers: {
        Cookie: fullCookie(cookie),
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const html = await resp.text();
    const names = extractKeyNamesFromHtml(html);
    _cachedKeyNames.set(cacheKey, { names, fetchedAt: Date.now() });
    console.log(`[WS KEYS] ${workspaceId}: found ${names.length} keys`);
    return names;
  } catch (e: any) {
    console.log(`[WS KEYS] ${workspaceId}: failed - ${e.message}`);
    return [];
  }
}

export async function fetchAllWorkspaceKeyNames(cookie: string, workspaceIds: string[]): Promise<Map<string, { keyID: string; name: string }[]>> {
  const results = new Map<string, { keyID: string; name: string }[]>();
  const batches = await Promise.all(workspaceIds.map(id => fetchWorkspaceKeyNames(cookie, id)));
  for (let i = 0; i < workspaceIds.length; i++) {
    results.set(workspaceIds[i], batches[i]);
  }
  return results;
}

export function clearKeyNameCache(): void {
  _cachedKeyNames.clear();
}

export interface WorkspaceWithKeys {
  id: string;
  name: string;
  slug: string;
  usage: WorkspaceUsage;
  keyNames: { keyID: string; name: string }[];
  fetchedAt: number;
}

/**
 * Workspace-centric fetch: given a session cookie, return all workspaces
 * with their key names and usage, organized by workspace (not by key).
 */
export async function fetchAllWorkspacesWithKeysAndUsage(cookie: string): Promise<WorkspaceWithKeys[]> {
  const { workspaces, email } = await fetchWorkspacesWithEmail(cookie);
  if (!workspaces || workspaces.length === 0) return [];
  const results: WorkspaceWithKeys[] = [];
  for (const ws of workspaces) {
    let keyNames: { keyID: string; name: string }[] = [];
    try { keyNames = await fetchWorkspaceKeyNames(cookie, ws.id); } catch { keyNames = []; }
    let usage: WorkspaceUsage;
    try { usage = await fetchWorkspaceUsage(cookie, ws.id); } catch { usage = { rollingUsage: null, weeklyUsage: null, monthlyUsage: null }; }
    results.push({ id: ws.id, name: ws.name, slug: ws.slug, usage, keyNames, fetchedAt: Date.now() });
  }
  return results;
}

export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "resetting";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}
