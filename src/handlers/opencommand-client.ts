// OpenCommand Client — separate key pool from OpenCode
// Uses OPENCOMMAND_KEYS env var for rotation
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDebug, setModelsList, getModelIds as getConsoleModelIds } from "../split-console.ts";
import { getProjectRoot } from "../shared.ts";

const CONFIG = {
  baseUrl: process.env.OPENCOMMAND_API_URL || "https://api.opencommand.ai/v1",
  maxRetries: 3,
};

const COOLDOWN_429_FIRST = 5 * 60 * 60 * 1000;
const COOLDOWN_429_SECOND = 7 * 24 * 60 * 60 * 1000;
const COOLDOWN_429_RETRY = 30 * 1000;
const CONSECUTIVE_429_THRESHOLD = 10;

let keys: string[] = [];
let balancer: KeyBalancer | null = null;
const key429Count = new Map<string, number>();

function ensureCacheDir(): string {
  const d = path.join(getProjectRoot(), ".cache");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function keyStatePath(): string {
  return path.join(ensureCacheDir(), "opencommand-key-state.json");
}

function keyId(k: string): string {
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 16);
}

function loadKeys() {
  const env = typeof process !== "undefined" ? process.env : {};
  let newKeys: string[] = [];
  if (env.OPENCOMMAND_KEYS) {
    try { newKeys = JSON.parse(env.OPENCOMMAND_KEYS).filter((k: string) => k.length > 5); } catch {}
  } else if (env.OPENCOMMAND_API_KEY && env.OPENCOMMAND_API_KEY.length > 5) {
    newKeys = [env.OPENCOMMAND_API_KEY];
  }
  const changed = keys.length !== newKeys.length || keys.some((k, i) => k !== newKeys[i]);
  keys = newKeys;
  if (keys.length > 0 && (!balancer || changed)) {
    balancer = new KeyBalancer(keys);
  }
}

class KeyBalancer {
  keys: string[];
  pool: string[] = [];
  cooldownUntil = new Map<string, number>();
  cooldownReason = new Map<string, string>();

  constructor(keys: string[]) {
    this.keys = keys;
  }

  _refillPool() {
    const now = Date.now();
    this.pool = [];
    for (const key of this.keys) {
      if (this.cooldownUntil.has(key) && this.cooldownUntil.get(key)! > now) continue;
      this.pool.push(key);
    }
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  hasAvailable(): boolean {
    const now = Date.now();
    for (const key of this.keys) {
      if (!this.cooldownUntil.has(key) || this.cooldownUntil.get(key)! <= now) return true;
    }
    return false;
  }

  getNextKey(): string {
    if (this.pool.length === 0) this._refillPool();
    return this.pool.pop() || "";
  }

  mark429(key: string, resetSeconds = 0) {
    const count = (key429Count.get(key) || 0) + 1;
    key429Count.set(key, count);
    let cdMs: number;
    if (resetSeconds > 0) {
      cdMs = resetSeconds * 1000;
    } else if (count >= CONSECUTIVE_429_THRESHOLD) {
      cdMs = this.cooldownUntil.has(key) && this.cooldownUntil.get(key)! > Date.now()
        ? COOLDOWN_429_SECOND : COOLDOWN_429_FIRST;
    } else {
      cdMs = COOLDOWN_429_RETRY;
    }
    this.cooldownUntil.set(key, Date.now() + cdMs);
    this.cooldownReason.set(key, "429");
  }

  mark401(key: string) {
    this.cooldownUntil.set(key, Date.now() + 60 * 60 * 1000);
    this.cooldownReason.set(key, "401");
  }

  mark402(key: string) {
    this.cooldownUntil.set(key, Date.now() + 14 * 24 * 60 * 60 * 1000);
    this.cooldownReason.set(key, "402");
  }

  markSuccess(key: string) {
    key429Count.set(key, 0);
    this.cooldownUntil.delete(key);
    this.cooldownReason.delete(key);
  }
}

function withKey(): string {
  loadKeys();
  if (!balancer) return keys[0] || "";
  return balancer.getNextKey();
}

export async function chatCompletion(modelId: string, messages: any[], tools?: any[], stream = true, extra: Record<string, any> = {}): Promise<Response> {
  loadKeys();
  const url = `${CONFIG.baseUrl}/chat/completions`;
  const key = withKey();

  const body: any = { ...extra };
  body.model = modelId;
  body.messages = messages;
  body.stream = stream;
  if (body.stream === false) delete body.stream;
  if (tools?.length) {
    body.tools = tools.map((t: any) => {
      if (t.type !== "function" || !t.function) {
        return { type: "function", function: { name: t.name || t.function?.name || "unknown", description: t.description || "", parameters: t.parameters || t.input_schema || {} } };
      }
      return t;
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 45000);
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    if (resp.status === 429 && key) {
      balancer?.mark429(key);
      if (balancer && !balancer.hasAvailable()) {
        throw new Error("All OpenCommand API keys are rate-limited.");
      }
      const newKey = withKey();
      if (newKey) {
        const h2: Record<string, string> = { "Content-Type": "application/json" };
        h2["Authorization"] = `Bearer ${newKey}`;
        const retryResp = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify(body) });
        if (retryResp.ok) return retryResp;
      }
    }
    if (resp.status === 401 && key) balancer?.mark401(key);
    if (resp.status === 402 && key) balancer?.mark402(key);
    throw new Error(`OpenCommand API ${resp.status}: ${txt}`);
  }

  if (key) balancer?.markSuccess(key);
  return resp;
}

export async function fetchModels(): Promise<string[]> {
  loadKeys();
  if (keys.length === 0) return [];
  try {
    const key = keys[0];
    const resp = await fetch(`${CONFIG.baseUrl}/models`, {
      headers: { "Authorization": `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      return (data?.data || []).map((m: any) => `oc/${typeof m === "string" ? m : m.id || ""}`).filter((id: string) => id.length > 4);
    }
  } catch {}
  return [];
}

export function getKeyStatus(): any[] {
  loadKeys();
  if (!balancer) return keys.map(k => ({ keyPrefix: k ? `${k.slice(0, 6)}...${k.slice(-4)}` : "none", status: "active" }));
  const now = Date.now();
  return balancer.keys.map(k => {
    const short = `${k.slice(0, 6)}...${k.slice(-4)}`;
    let status = "active";
    let reason: string | null = null;
    if (balancer!.cooldownUntil.has(k)) {
      const until = balancer!.cooldownUntil.get(k)!;
      if (until > now) {
        reason = balancer!.cooldownReason.get(k) || null;
        status = reason === "401" ? "auth_denied" : "cooldown";
      }
    }
    return { keyPrefix: short, status, reason, consecutive429: key429Count.get(k) || 0 };
  });
}

export function hasKeys(): boolean {
  loadKeys();
  return keys.length > 0;
}
