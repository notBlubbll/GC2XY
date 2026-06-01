import * as crypto from "node:crypto";

export interface WorkspaceUsage {
  rollingUsage: { usagePercent: number; resetInSec: number } | null;
  weeklyUsage: { usagePercent: number; resetInSec: number } | null;
  monthlyUsage?: { usagePercent: number; resetInSec: number } | null;
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
  keyToken?: string;
  session: string;
  error?: string;
  workspaces: WorkspaceWithUsage[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const WORKSPACE_FN = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";

function fullCookie(raw: string): string {
  if (!raw.includes("=")) return `oc_locale=en; auth=${raw}`;
  if (raw.includes(";")) return raw;
  // Already has auth= prefix but no oc_locale
  if (raw.startsWith("auth=")) return `oc_locale=en; ${raw}`;
  return raw;
}

async function checkSession(text: string): Promise<void> {
  if (text.includes("not associated with an account") || text.includes("auth/authorize") || text.includes("sign in")) {
    throw new Error("session expired");
  }
}

function extractWorkspacesFromServer(text: string): { id: string; name: string }[] {
  const names = new Map<string, string>();
  const blockRe = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text)) !== null) {
    const b = block[0];
    const idMatch = b.match(/id\s*:\s*"(wrk_[^"]+)"/);
    const nameMatch = b.match(/name\s*:\s*"([^"]+)"/);
    if (idMatch && nameMatch) names.set(idMatch[1], nameMatch[1]);
  }
  return [...names.entries()].map(([id, name]) => ({ id, name }));
}

function extractUsageFromHtml(html: string): WorkspaceUsage {
  const result: WorkspaceUsage = { rollingUsage: null, weeklyUsage: null };
  const rRollRe = /rollingUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:([0-9.]+)\}/;
  const rWeekRe = /weeklyUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:([0-9.]+)\}/;
  const rMonthRe = /monthlyUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:([0-9.]+)\}/;

  let m: RegExpExecArray | null;
  m = rRollRe.exec(html);
  if (m) result.rollingUsage = { usagePercent: parseFloat(m[2]), resetInSec: parseInt(m[1]) };
  m = rWeekRe.exec(html);
  if (m) result.weeklyUsage = { usagePercent: parseFloat(m[2]), resetInSec: parseInt(m[1]) };
  m = rMonthRe.exec(html);
  if (m) result.monthlyUsage = { usagePercent: parseFloat(m[2]), resetInSec: parseInt(m[1]) };
  return result;
}

export async function fetchWorkspaces(cookie: string): Promise<{ id: string; name: string }[]> {
  const instanceId = `oc-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await fetch("https://opencode.ai/_server?id=" + encodeURIComponent(WORKSPACE_FN), {
    method: "GET",
    headers: {
      Cookie: fullCookie(cookie),
      "X-Server-Id": WORKSPACE_FN,
      "X-Server-Instance": instanceId,
      "User-Agent": UA,
      Origin: "https://opencode.ai",
      Referer: "https://opencode.ai/",
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
    },
  });
  const text = await resp.text();
  await checkSession(text);
  return extractWorkspacesFromServer(text);
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
  return extractUsageFromHtml(text);
}

export async function getWorkspaceDataForKey(key: string, keyName: string, cookie: string): Promise<KeyWorkspaceData> {
  const keyPrefix = key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "none";
  const keyId = crypto.createHash("sha256").update(key || "").digest("hex").slice(0, 8);
  const data: KeyWorkspaceData = { keyPrefix, keyId, keyName, keyToken: key, session: cookie, workspaces: [] };
  if (!cookie) { data.error = "no session cookie"; return data; }
  try {
    const workspaces = await fetchWorkspaces(cookie);
    if (!workspaces || workspaces.length === 0) { data.error = "no workspaces found"; return data; }
    data.workspaces = await Promise.all(workspaces.map(async (ws) => {
      let usage: WorkspaceUsage;
      try { usage = await fetchWorkspaceUsage(cookie, ws.id); } catch { usage = { rollingUsage: null, weeklyUsage: null }; }
      return { ...ws, usage, fetchedAt: Date.now() };
    }));
  } catch (e: any) { data.error = e?.message || "unknown error"; }
  return data;
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
