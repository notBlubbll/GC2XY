// Agnes AI provider — models via apihub.agnes-ai.com
// Key stored in .config/config.json as agnesKey

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectRoot, normalizeTool, normalizeToolChoice } from "../shared.ts";
import { isDebug } from "../split-console.ts";

const BASE = "https://apihub.agnes-ai.com/v1";

function getAgnesKey(): string {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      return c.agnesKey || "";
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
  return path.join(ensureCacheDir(), "models-agnes.json");
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

// ── Model Init ──
let _cachedIds: string[] | null = null;
let _initialized = false;

async function fetchModels(): Promise<string[]> {
  try {
    const apiKey = getAgnesKey();
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
    if (isDebug()) console.log(`\n[AGNES] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[AGNES] fetch error: ${e.message}`);
  }
  return [];
}

export async function initModels(): Promise<string[]> {
  if (_initialized && _cachedIds) return _cachedIds;

  const disk = loadCachedModels();
  if (disk && disk.length > 0) {
    _cachedIds = disk;
    _initialized = true;
    if (isDebug()) console.log(`\n[AGNES] loaded ${disk.length} from disk`);
    return disk;
  }

  const fetched = await fetchModels();
  if (fetched.length > 0) {
    _cachedIds = fetched;
  }
  _initialized = true;
  if (isDebug()) console.log(`\n[AGNES] init complete: ${_cachedIds?.length || 0} models`);
  return _cachedIds || [];
}

export function getModelIds(): string[] {
  return _initialized ? (_cachedIds || []) : [];
}

// ── Request Dedup (cooldown-based) ──
const _lastDone = new Map<string, number>();
const DEDUP_COOLDOWN_MS = 5000;
function _dedupKey(modelId: string, messages: any[]): string {
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content.slice(-200) :
    Array.isArray(lastUser?.content) ? lastUser.content.map((c: any) => c.text || "").join("").slice(-200) : "";
  return `${modelId}:${prompt}`;
}

// ── Chat Completion ──
export async function chatCompletion(
  modelId: string,
  messages: any[],
  tools?: any[],
  stream = true,
  extra: Record<string, any> = {}
): Promise<Response> {
  const key = getAgnesKey();
  if (!key) throw new Error("No AGNES API key configured.");

  const strippedModel = modelId.replace(/^agnes\//, "");
  const url = `${BASE}/chat/completions`;

  const body: any = { ...extra };
  delete body.tool_choice;
  body.model = strippedModel;
  body.messages = messages.map((msg: any) => {
    const out: any = { role: msg.role, content: msg.content };
    if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
    if (msg.reasoning) out.reasoning = msg.reasoning;
    return out;
  });
  body.stream = false; // Non-streaming: AGNES streaming drops tool calls
  if (tools !== undefined) {
    body.tools = tools.length ? tools.map(normalizeTool) : undefined;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    "User-Agent": "gc2xy/3.0",
  };

  const logBody = JSON.stringify({
    model: body.model, stream: body.stream,
    msgs: body.messages?.length || 0,
    tools: body.tools?.length || 0,
  });
  console.log(`[AGNES] POST ${url} | model=${strippedModel} | msgs=${body.messages?.length || 0} tools=${body.tools?.length || 0}`);

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

      console.log(`[AGNES] ${resp.status} ${strippedModel} | ct=${resp.headers.get("content-type")} stream=${body.stream}`);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.log(`[AGNES] ERROR ${resp.status} ${strippedModel} | body="${txt.slice(0, 500)}"`);
        throw new Error(`AGNES ${resp.status}: ${txt}`);
      }

      return resp;
    } finally {
      clearTimeout(t);
    }
  })();
  return promise;
}
