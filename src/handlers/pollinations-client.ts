// Pollinations provider — free models via text.pollinations.ai
// Authenticated tier: enter.pollinations.ai (bypasses 1-req/IP free-tier queue limit)
// Key stored in .config/config.json as pollApiKey

import * as fs from "node:fs";
import * as path from "node:path";
import { isDebug } from "../split-console.ts";
import { getProjectRoot } from "../shared.ts";

const LEGACY_BASE = "https://text.pollinations.ai/openai";
const AUTH_BASE = "https://enter.pollinations.ai/api/openai/v1";

function getPollKey(): string {
  try {
    const p = path.join(getProjectRoot(), ".config", "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      return c.pollApiKey || "";
    }
  } catch {}
  return "";
}

// ── Cached state ──
let _cachedIds: string[] | null = null;
let _initialized = false;

export async function initModels(): Promise<string[]> {
  if (_initialized && _cachedIds) return _cachedIds;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch("https://text.pollinations.ai/models", { signal: ctrl.signal });
    clearTimeout(t);
    if (resp.ok) {
      const data: any = await resp.json();
      const ids = (data || []).map((m: any) => `pol/${m.name}`).filter((id: string) => id.length > 4);
      if (ids.length > 0) {
        _cachedIds = ids;
        _initialized = true;
        if (isDebug()) console.log(`\n[POLL] fetched ${ids.length} models`);
        return ids;
      }
    }
    if (isDebug()) console.log(`\n[POLL] fetch returned ${resp.status}`);
  } catch (e: any) {
    if (isDebug()) console.log(`\n[POLL] fetch error: ${e.message}`);
  }

  _cachedIds = ["pol/openai-fast"];
  _initialized = true;
  if (isDebug()) console.log(`\n[POLL] using fallback: pol/openai-fast`);
  return _cachedIds;
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
export async function chatCompletion(modelId: string, messages: any[], tools?: any[], stream = true, extra: Record<string, any> = {}): Promise<Response> {
  const strippedModel = modelId.replace(/^pol\//, "");
  const apiKey = getPollKey();
  const useAuth = !!apiKey;
  const base = useAuth ? AUTH_BASE : LEGACY_BASE;
  const url = `${base}/chat/completions`;

  const body: any = { ...extra };
  body.model = strippedModel;
  body.messages = messages.map((msg: any) => {
    const out: any = { role: msg.role, content: msg.content };
    if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    return out;
  });
  body.stream = stream;
  if (body.stream === false) delete body.stream;
  if (tools?.length) body.tools = tools;

  const logBody = JSON.stringify({ model: body.model, stream: body.stream, msgs: body.messages?.length || 0, tools: body.tools?.length || 0, auth: useAuth });
  console.log(`[POLL] POST ${url} | body=${logBody}`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useAuth) headers["Authorization"] = `Bearer ${apiKey}`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  const promise = (async (): Promise<Response> => {
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.log(`[POLL] ${resp.status} ${modelId} | body="${txt.slice(0, 500)}"`);
        throw new Error(`Poll API ${resp.status}: ${txt}`);
      }

      return resp;
    } finally {
      clearTimeout(t);
    }
  })();
  return promise;
}
