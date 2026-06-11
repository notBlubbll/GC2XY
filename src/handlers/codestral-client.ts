// Codestral (Mistral AI) provider — models via codestral.mistral.ai
// Key stored in .config/config.json as codestralKey

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectRoot, normalizeTool, normalizeToolChoice } from "../shared.ts";
import { isDebug } from "../split-console.ts";

const BASE = "https://codestral.mistral.ai/v1";

function getCodestralKey(): string {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      return c.codestralKey || "";
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
  return path.join(ensureCacheDir(), "models-codestral.json");
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

// Known Codestral models (fallback if API /models is unavailable)
const KNOWN_MODELS = [
  "codestral/codestral-latest",
  "codestral/codestral-2505",
  "codestral/codestral-2405",
];

// ── Model Init ──
let _cachedIds: string[] | null = null;
let _initialized = false;

async function fetchModels(): Promise<string[]> {
  try {
    const apiKey = getCodestralKey();
    if (!apiKey) return KNOWN_MODELS;
    const resp = await fetch(`${BASE}/models`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "User-Agent": "gc2xy/3.0" },
    });
    if (resp.ok) {
      const data: any = await resp.json();
      const ids: string[] = (data?.data || []).map((m: any) =>
        typeof m === "string" ? m : m.id || ""
      ).filter((id: string) => id.length > 0).map((id: string) => id.startsWith("codestral/") ? id : `codestral/${id}`);
      if (ids.length > 0) {
        saveCachedModels(ids);
        return ids;
      }
    }
    if (isDebug()) console.log(`\n[CODESTRAL] fetch returned ${resp.status}, using known models`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[CODESTRAL] fetch error: ${e.message}, using known models`);
  }
  return KNOWN_MODELS;
}

export async function initModels(): Promise<string[]> {
  if (_initialized && _cachedIds) return _cachedIds;

  const disk = loadCachedModels();
  if (disk && disk.length > 0) {
    const migrated = disk.map(id => id.startsWith("codestral/") ? id : `codestral/${id}`);
    if (migrated.some((id, i) => id !== disk[i])) saveCachedModels(migrated);
    _cachedIds = migrated;
    _initialized = true;
    if (isDebug()) console.log(`\n[CODESTRAL] loaded ${migrated.length} from disk`);
    return migrated;
  }

  const fetched = await fetchModels();
  if (fetched.length > 0) {
    _cachedIds = fetched;
    saveCachedModels(fetched);
  }
  _initialized = true;
  if (isDebug()) console.log(`\n[CODESTRAL] init complete: ${_cachedIds?.length || 0} models`);
  return _cachedIds || KNOWN_MODELS;
}

export function getModelIds(): string[] {
  return _initialized ? (_cachedIds || KNOWN_MODELS) : KNOWN_MODELS;
}

// ── Legacy Completions (prompt+suffix) ──
export async function completions(
  prompt: string,
  suffix: string,
  modelId: string,
  extra: Record<string, any> = {}
): Promise<Response> {
  const key = getCodestralKey();
  if (!key) throw new Error("No Codestral API key configured.");

  const strippedModel = modelId.replace(/^codestral\//, "");
  const url = `${BASE}/fim/completions`;

  const body: any = {
    model: strippedModel,
    prompt,
    suffix: suffix || "",
    max_tokens: extra.max_tokens ?? 500,
    temperature: extra.temperature ?? 0,
    top_p: extra.top_p ?? 1,
    stop: extra.stop,
    stream: extra.stream ?? false,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    "User-Agent": "gc2xy/3.0",
  };

  console.log(`[CODESTRAL] POST ${url} | model=${strippedModel} | prompt="${prompt.substring(0, 80)}..."`);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    console.log(`[CODESTRAL] ${resp.status} completions ${strippedModel} | ct=${resp.headers.get("content-type")}`);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.log(`[CODESTRAL] ERROR ${resp.status} completions ${strippedModel} | body="${txt.slice(0, 500)}"`);
      throw new Error(`Codestral completions ${resp.status}: ${txt}`);
    }

    return resp;
  } finally {
    clearTimeout(t);
  }
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
  const key = getCodestralKey();
  if (!key) throw new Error("No Codestral API key configured.");

  const strippedModel = modelId.replace(/^codestral\//, "");
  const url = `${BASE}/chat/completions`;

  let _toolChoice: any;
  if (extra.tool_choice !== undefined) {
    _toolChoice = normalizeToolChoice(extra.tool_choice);
    delete extra.tool_choice;
  }

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
  if (_toolChoice !== undefined) body.tool_choice = _toolChoice;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
    "User-Agent": "gc2xy/3.0",
  };

  console.log(`[CODESTRAL] POST ${url} | model=${strippedModel} | msgs=${body.messages?.length || 0} tools=${body.tools?.length || 0}`);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 120000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    console.log(`[CODESTRAL] ${resp.status} ${strippedModel} | ct=${resp.headers.get("content-type")} stream=${body.stream}`);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.log(`[CODESTRAL] ERROR ${resp.status} ${strippedModel} | body="${txt.slice(0, 500)}"`);
      throw new Error(`Codestral ${resp.status}: ${txt}`);
    }

    return resp;
  } finally {
    clearTimeout(t);
  }
}
