// Featherless provider — models via api.featherless.ai
// OpenAI-compatible: /v1/chat/completions, /v1/models
// Key stored in .config/config.json as featherlessKey

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectRoot, normalizeTool } from "../shared.ts";
import { isDebug } from "../split-console.ts";

const BASE = "https://api.featherless.ai/v1";

function getFeatherlessKey(): string {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      return c.featherlessKey || "";
    }
  } catch {}
  return "";
}

function ensureCacheDir(): string {
  const d = path.join(getProjectRoot(), ".cache");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function modelDiskPath(): string {
  return path.join(ensureCacheDir(), "models-featherless.json");
}

function loadCachedModels(): string[] | null {
  try {
    const p = modelDiskPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return null;
}

function saveCachedModels(ids: string[]) {
  try {
    fs.writeFileSync(modelDiskPath(), JSON.stringify(ids));
  } catch {}
}

let _cachedIds: string[] | null = null;
let _initialized = false;

async function fetchModels(): Promise<string[]> {
  try {
    const apiKey = getFeatherlessKey();
    if (!apiKey) return [];
    const resp = await fetch(`${BASE}/models`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "User-Agent": "gc2xy/3.0" },
    });
    if (resp.ok) {
      const data: any = await resp.json();
      const ids: string[] = (data?.data || []).map((m: any) =>
        typeof m === "string" ? m : m.id || ""
      ).filter((id: string) => id.length > 0);
      if (ids.length > 0) {
        saveCachedModels(ids);
        return ids;
      }
    }
    if (isDebug()) console.log(`\n[FEATHERLESS] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[FEATHERLESS] fetch error: ${e.message}`);
  }
  return [];
}

export async function initModels(): Promise<string[]> {
  if (_initialized && _cachedIds) return _cachedIds;

  const disk = loadCachedModels();
  if (disk && disk.length > 0) {
    _cachedIds = disk.map(id => `featherless/${id}`);
    _initialized = true;
    if (isDebug()) console.log(`\n[FEATHERLESS] loaded ${disk.length} from disk`);
    return _cachedIds;
  }

  const fetched = await fetchModels();
  if (fetched.length > 0) {
    _cachedIds = fetched.map(id => `featherless/${id}`);
  }
  _initialized = true;
  if (isDebug()) console.log(`\n[FEATHERLESS] init complete: ${_cachedIds?.length || 0} models`);
  return _cachedIds || [];
}

export function getModelIds(): string[] {
  if (!_initialized || !_cachedIds) return [];
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      const dm = c.disabledModels as Record<string, string[]> | undefined;
      const disabledSet = new Set(dm?.featherless || []);
      return _cachedIds.filter(id => !disabledSet.has(id));
    }
  } catch {}
  return _cachedIds;
}

// ── Search Featherless Catalog ──
export async function searchModels(query: string): Promise<{ id: string; name: string; description?: string; context_length?: number }[]> {
  try {
    const apiKey = getFeatherlessKey();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("per_page", "50");
    const url = `${BASE}/models?${params.toString()}`;
    const headers: Record<string, string> = { "User-Agent": "gc2xy/3.0" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (resp.ok) {
      const data: any = await resp.json();
      return (data?.data || []).map((m: any) => ({
        id: m.id || "",
        name: m.name || m.id?.split("/").pop() || "",
        description: m.description || "",
        context_length: m.context_length || 0,
      })).filter((m: any) => m.id);
    }
  } catch {}
  return [];
}

// ── Chat Completion ──
export async function chatCompletion(
  modelId: string,
  messages: any[],
  tools?: any[],
  stream = true,
  extra: Record<string, any> = {}
): Promise<Response> {
  const key = getFeatherlessKey();
  if (!key) throw new Error("No Featherless API key configured.");

  const strippedModel = modelId.replace(/^featherless\//, "");
  const url = `${BASE}/chat/completions`;

  const body: any = { ...extra };
  body.model = strippedModel;
  body.messages = messages.map((msg: any) => {
    const out: any = { role: msg.role, content: msg.content };
    if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
    if (msg.reasoning) out.reasoning = msg.reasoning;
    return out;
  });
  body.stream = stream;
  if (body.stream === false) delete body.stream;
  if (tools !== undefined) {
    body.tools = tools.length ? tools.map(normalizeTool) : undefined;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    "User-Agent": "gc2xy/3.0",
  };

  console.log(`[FEATHERLESS] POST ${url} | model=${strippedModel} | msgs=${body.messages?.length || 0} tools=${body.tools?.length || 0}`);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 120000);
  const promise = (async (): Promise<Response> => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      console.log(`[FEATHERLESS] ${resp.status} ${strippedModel} | ct=${resp.headers.get("content-type")} stream=${body.stream}`);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.log(`[FEATHERLESS] ERROR ${resp.status} ${strippedModel} | body="${txt.slice(0, 500)}"`);
        throw new Error(`FEATHERLESS ${resp.status}: ${txt}`);
      }

      return resp;
    } finally {
      clearTimeout(t);
    }
  })();
  return promise;
}
