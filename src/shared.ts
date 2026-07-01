import forge from "node-forge";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function readJsonSync(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
}

type ProxyMode = "mock" | "hybrid" | "proxy";

let _currentMode: ProxyMode = "mock";

// ── Nag handling ──
const NAG_RE = /not yet (marked|complete)/i;

export const RECENTLY_COMPLETED = new Map<string, number>();
export const TASK_COMPLETED_SESSIONS = new Map<string, boolean>();
export const RECENT_BODIES = new Map<string, number>();

export function countConsecutiveNags(messages: any[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const content = typeof m.content === "string" ? m.content :
      Array.isArray(m.content) ? m.content.map((c: any) => c.text || "").join(" ") : "";
    if (NAG_RE.test(content)) count++;
    else break;
  }
  return count;
}

export function lastAssistantHasToolCalls(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return !!(m.tool_calls?.length);
  }
  return false;
}

export function stripNagMessages(messages: any[]): { messages: any[]; stripped: number } {
  const before = messages.length;
  const filtered = messages.filter((m: any) => {
    if (m?.role !== "user") return true;
    const content = typeof m.content === "string" ? m.content :
      Array.isArray(m.content) ? m.content.map((c: any) => c.text || "").join(" ") : "";
    return !NAG_RE.test(content);
  });
  return { messages: filtered, stripped: before - filtered.length };
}

// Periodic purge
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of RECENTLY_COMPLETED) {
    if (now - ts > 30000) RECENTLY_COMPLETED.delete(k);
  }
  for (const [k, ts] of RECENT_BODIES) {
    if (now - ts > 30000) RECENT_BODIES.delete(k);
  }
}, 10000);

// ── Tool normalization (shared across all providers) ──
export function normalizeTool(tool: any): any {
  const t = { ...tool };
  if (t.function) {
    const fn: any = { name: t.function.name };
    if (t.function.description) fn.description = t.function.description;
    if (t.function.parameters) fn.parameters = t.function.parameters;
    if (t.function.strict !== undefined) fn.strict = t.function.strict;
    t.function = fn;
    if (!t.type) t.type = "function";
  } else if (t.name && (t.input_schema || t.parameters)) {
    const fn: any = { name: t.name, parameters: t.input_schema || t.parameters };
    if (t.description) fn.description = t.description;
    t.function = fn;
    t.type = "function";
    delete t.name;
    delete t.input_schema;
    delete t.parameters;
    delete t.description;
  }
  return t;
}

// ── Safe preview extraction from message content ──
// Returns a plain string for console logging. Guards against non-string
// .text fields (objects, arrays, numbers) that would otherwise stringify
// to "[object Object]" when joined.
export function safePreviewFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") { parts.push(c); continue; }
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" || c.type === "input_text" || c.type === "output_text") {
      const t = c.text;
      if (typeof t === "string") parts.push(t);
      else if (t != null) parts.push(safePreviewFromContent(t));
    }
  }
  return parts.join(" ");
}

// ── Tool call ID normalization ──
// Upstream LLMs (umans, agnes, freebuff) often emit non-standard tool_call IDs
// like "functions.get_projects_in_solution:0" or "call_24c64518159842a492cd00ee".
// VS requires proper prefixed IDs to match tool_results back:
//   - Anthropic /v1/messages format: "toolu_" prefix
//   - OpenAI /responses format: "call_" prefix
// If the upstream ID doesn't match the expected prefix, generate a proper one.
export function normalizeToolCallId(id: string | undefined, format: "anthropic" | "openai" = "anthropic"): string {
  const prefix = format === "anthropic" ? "toolu_" : "call_";
  if (id && id.startsWith(prefix) && id.length > prefix.length + 8) {
    return id;
  }
  return `${prefix}${forge.util.bytesToHex(forge.random.getBytesSync(12))}`;
}

// ── Tool description compression (from gc2oc token-optimizer.js) ──
export function compressDescription(desc: string): string {
  if (!desc) return "";
  let c = desc
    .replace(/^(This tool|Use this tool|This function|Use this function)\b/gi, "")
    .replace(/\b(allows you to|enables you to|lets you|helps you|can be used to)\b/gi, " ")
    .replace(/\b(the following|is not case sensitive)\b/gi, " ")
    .replace(/You must have .+? access/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (c.length > 120) {
    const first = c.match(/^[^.!?]+[.!?]/);
    c = first ? first[0] : c.slice(0, 120) + "...";
  }
  return c;
}

function compressToolSchemaImpl(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  if (schema.type) out.type = schema.type;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.properties) {
    out.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      out.properties[key] = compressToolSchemaImpl(prop);
    }
  }
  if (schema.items) out.items = compressToolSchemaImpl(schema.items);
  return out;
}

export function compressToolDefinitions(tools: any[]): any[] {
  if (!tools?.length) return tools;
  return tools.map((t: any) => ({
    type: "function",
    function: {
      name: t.function?.name || t.name || "unknown",
      description: compressDescription(t.function?.description || t.description || ""),
      parameters: compressToolSchemaImpl(t.function?.parameters || t.parameters || {}),
    },
  }));
}

export function normalizeToolChoice(tc: any): any {
  if (!tc || typeof tc === "string") return tc || "auto";
  if (tc.type === "function" && tc.function?.name) return { type: "function", function: { name: tc.function.name } };
  if (tc.type === "auto" || tc.type === "any") return "auto";
  if (tc.type === "required") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  if (typeof tc === "object") return "auto";
  return tc;
}

// Mode resolution (priority: --mode <m> > gc2xy_MODE env > --restart [config.json] > default mock)
// Backward compat: --mode-3 / --mode-2 still honored.
// On restart (exit 42), launchers pass --restart so we read the persisted mode from config.json.
const _ARGS = typeof process !== "undefined" ? process.argv.slice(1) : [];
const _ARGS_SET = new Set(_ARGS);

function _readModeFromConfig(): ProxyMode | null {
  try {
    const configPath = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(configPath)) {
      const cfg = readJsonSync(configPath);
      if (cfg.mode === "mock" || cfg.mode === "hybrid" || cfg.mode === "proxy") return cfg.mode;
    }
  } catch {}
  return null;
}

function _resolveInitialMode(): ProxyMode {
  // 1. Explicit --mode <mode> param (highest priority)
  const modeIdx = _ARGS.indexOf("--mode");
  if (modeIdx !== -1 && _ARGS[modeIdx + 1]) {
    const m = String(_ARGS[modeIdx + 1]).toLowerCase();
    if (m === "mock" || m === "hybrid" || m === "proxy") return m;
  }
  // 2. Legacy --mode-3 / --mode-2 flags
  if (_ARGS_SET.has("--mode-3")) return "proxy";
  if (_ARGS_SET.has("--mode-2")) return "hybrid";
  // 3. gc2xy_MODE env var
  if (process.env.gc2xy_MODE === "proxy") return "proxy";
  if (process.env.gc2xy_MODE === "hybrid") return "hybrid";
  if (process.env.gc2xy_MODE === "mock") return "mock";
  // 4. --restart flag: read persisted mode from config.json
  if (_ARGS_SET.has("--restart")) {
    const persisted = _readModeFromConfig();
    if (persisted) return persisted;
  }
  // 5. Default
  return "mock";
}

_currentMode = _resolveInitialMode();
process.env.gc2xy_MODE = _currentMode;
// Always persist the resolved mode so config.json + restart-mode stay in sync
// (covers initial start, restart, and explicit switches)
_persistMode(_currentMode);

export function getMode(): ProxyMode { return _currentMode; }
export function setMode(m: ProxyMode) {
  _currentMode = m;
  process.env.gc2xy_MODE = m;
  _persistMode(m);
}

// Persist mode to BOTH .config/config.json (authoritative) AND .cache/restart-mode (legacy cache file).
function _persistMode(m: ProxyMode): void {
  // config.json
  try {
    const configDir = join(getProjectRoot(), ".config");
    const configPath = join(configDir, "config.json");
    const cfg = existsSync(configPath) ? readJsonSync(configPath) : {};
    cfg.mode = m;
    if (!existsSync(configDir)) try { mkdirSync(configDir, { recursive: true }); } catch {}
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch {}
  // .cache/restart-mode (legacy, kept for backward compat with old launcher scripts)
  try {
    const cacheDir = join(getProjectRoot(), ".cache");
    if (!existsSync(cacheDir)) try { mkdirSync(cacheDir, { recursive: true }); } catch {}
    writeFileSync(join(cacheDir, "restart-mode"), m, "utf8");
  } catch {}
}
export function isProxy() { return _currentMode === "proxy"; }
export function isHybrid() { return _currentMode === "hybrid"; }
export function isMock() { return _currentMode === "mock"; }

export function getProjectRoot(): string {
  let dir: string;

  // 1. Try import.meta.dirname (works for source & Node portable runs)
  try {
    const metaDir = typeof import.meta.dirname !== "undefined"
      ? import.meta.dirname
      : dirname(fileURLToPath(import.meta.url));
    dir = resolve(metaDir);
  } catch {
    dir = "";
  }

  // 2. Detect virtual / bundled paths (Bun standalone reports internal paths like ~BUN)
  const isVirtual = !dir
    || dir === "\\"
    || dir === "/"
    || dir.includes("~BUN")
    || dir.includes("/$bun")
    || dir.length < 4;

  if (isVirtual) {
    // Derive from the actual executable location
    try {
      const exePath = process.execPath || process.argv[0] || "";
      if (exePath) {
        dir = resolve(dirname(exePath));
      }
    } catch {
      dir = resolve(process.cwd());
    }
  }

  // 3. If we're inside src/, go up one level
  if (dir.endsWith("\\src") || dir.endsWith("/src")) {
    dir = resolve(join(dir, ".."));
  }

  // 4. If we're inside .dist/, stay if it has own .certs, else go up
  if (dir.endsWith("\\.dist") || dir.endsWith("/.dist")) {
    if (!existsSync(join(dir, ".certs"))) {
      dir = resolve(join(dir, ".."));
    }
  }

  // 5. Validate by looking for project markers
  if (existsSync(join(dir, ".certs"))
    || existsSync(join(dir, "package.json"))
    || existsSync(join(dir, "AGENTS.md"))) {
    return dir;
  }

  // 6. Fall back to cwd, or its parent if cwd itself is .dist/
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, ".certs"))
    || existsSync(join(cwd, "package.json"))) {
    return cwd;
  }
  if (cwd.endsWith("\\.dist") || cwd.endsWith("/.dist")) {
    const parent = resolve(join(cwd, ".."));
    if (existsSync(join(parent, ".certs"))
      || existsSync(join(parent, "package.json"))) {
      return parent;
    }
  }

  return dir;
}

export type HttpResponse = { statusCode: number; headers: Record<string, string>; body: Buffer; _streamed?: boolean };
export type HandlerInput = { method: string; url: string; headers: Record<string, string>; body: Buffer | null; hostname?: string; port?: number; clientSocket?: import("node:net").Socket };
export type HandlerResult = { handled: boolean; response?: HttpResponse };

export function jsonResponse(body: Record<string, any>, status = 200): HttpResponse {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
    body: Buffer.from(JSON.stringify(body)),
  };
}

/**
 * GitHub API JSON response — includes the standard OAuth/rate-limit headers
 * that Octokit.net (VS Team Explorer) checks to verify token validity.
 * Without x-oauth-scopes, VS reports "User is not signed into GitHub".
 */
export function ghApiJsonResponse(body: Record<string, any>, status = 200, extra: Record<string, string> = {}): HttpResponse {
  const now = Math.floor(Date.now() / 1000);
  const reset = now + 3600;
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, max-age=60, s-maxage=60",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset, Warning",
      "x-oauth-scopes": "gist, read:org, repo, user, workflow, write:public_key",
      "x-oauth-client-id": "a200baed193bb2088a6e",
      "x-accepted-oauth-scopes": "",
      "x-github-media-type": "github.v3; format=json",
      "x-github-api-version-selected": "2022-11-28",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(reset),
      "x-ratelimit-used": "1",
      "x-ratelimit-resource": "core",
      "x-github-request-id": `MITM:${Date.now().toString(16)}`,
      "strict-transport-security": "max-age=31536000; includeSubdomains; preload",
      "x-frame-options": "deny",
      "x-content-type-options": "nosniff",
      "x-xss-protection": "0",
      "referrer-policy": "origin-when-cross-origin, strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'none'",
      "server": "github.com",
      ...extra,
    },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function htmlResponse(html: string, status = 200): HttpResponse {
  return {
    statusCode: status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(html),
  };
}

// Scrub task_complete tool calls from messages and tools before sending to LLM.
// task_complete is a VS-specific client-side tool that real LLMs don't understand.
export function scrubTaskComplete(messages: any[], tools?: any[]): { messages: any[]; tools: any[] } {
  const taskCompleteIds = new Set<string>();
  const cleanedTools = (tools || []).filter((t: any) => {
    const fn = t.function || t;
    if ((fn.name || "") === "task_complete") return false;
    return true;
  });

  // First pass: collect all task_complete IDs from assistant messages
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || tc;
        if ((fn.name || "") === "task_complete") taskCompleteIds.add(tc.id || "");
      }
    }
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "tool_use" && c.name === "task_complete") {
          taskCompleteIds.add(c.id || c.tool_use_id || "");
        }
      }
    }
  }

  // Second pass: filter out task_complete and their tool responses, transform assistants
  const cleanedMessages = messages.filter((m: any) => {
    if (m.role === "tool" && m.tool_call_id && taskCompleteIds.has(m.tool_call_id)) return false;
    if (Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result" && taskCompleteIds.has(c.tool_use_id))) return false;
    return true;
  }).map((m: any) => {
    if (m.role !== "assistant") return m;
    // OpenAI format: filter task_complete from tool_calls
    if (m.tool_calls?.length) {
      const filtered = m.tool_calls.filter((tc: any) => {
        const fn = tc.function || tc;
        return (fn.name || "") !== "task_complete";
      });
      if (filtered.length !== m.tool_calls.length) {
        if (filtered.length > 0) return { ...m, tool_calls: filtered };
        if (m.content) return { ...m, tool_calls: undefined };
        return { role: "user", content: "[task completed]" };
      }
    }
    // Anthropic format: filter tool_use content blocks for task_complete
    if (Array.isArray(m.content)) {
      const filtered = m.content.filter((c: any) => !(c.type === "tool_use" && c.name === "task_complete"));
      if (filtered.length !== m.content.length) {
        const textParts = filtered.filter((c: any) => c.type === "text").map((c: any) => c.text || "");
        if (textParts.length > 0) return { role: m.role, content: textParts.join(" ") };
        return { role: "user", content: "[task completed]" };
      }
    }
    return m;
  });

  return { messages: cleanedMessages, tools: cleanedTools };
}

export function buildSseResponse(content: string, model: string): string {
  const id = `chatcmpl-${forge.util.bytesToHex(forge.random.getBytesSync(6))}`;
  const created = Math.floor(Date.now() / 1000);
  const words = content.split(" ");
  let result = "";
  result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`;
  for (let i = 0; i < words.length; i++) {
    const chunk = i < words.length - 1 ? words[i] + " " : words[i];
    result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{"content":"${chunk.replace(/"/g, '\\"')}"},"finish_reason":null}]}\n\n`;
  }
  result += `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
  result += "data: [DONE]\n\n";
  return result;
}

// ── Github Settings (shared config for fake auth responses) ──
let _githubSku = "enterprise";
let _githubUsername = "fake-github-user";
let _githubDisplayName = "Fake Github User";

export function setGithubSku(v: string) { _githubSku = v; }
export function setGithubUsername(v: string) { _githubUsername = v; }
export function setGithubDisplayName(v: string) { _githubDisplayName = v; }
export function getGithubSku() { return _githubSku; }
export function getGithubUsername() { return _githubUsername; }
export function getGithubDisplayName() { return _githubDisplayName; }

export function compactIdentity(displayName: string, modelId?: string, thinkingTag?: string): string {
  const thinkNote = thinkingTag ? ` [${thinkingTag.toLowerCase()} thinking mode]` : "";
  const modelRef = modelId ? `${displayName} (${modelId})` : displayName;
  return `IDENTITY OVERRIDE: You are NOT GitHub Copilot. You are "Copilot (gc2xy)", a coding assistant running ${modelRef}${thinkNote}. When asked who you are, say: "I am Copilot (gc2xy) running ${modelRef}${thinkNote}." Never claim to be GitHub Copilot. Never start your response with any greeting, introduction, or "Hello! I'm..." — just get straight to the answer.\n\nNEVER open with phrases like "The pattern", "The issue", "The fix", "The key", "The problem", "The approach", "The code", "Here's a concrete example", "Here's an implementation", "Let me break this down", "Let me think about this", "Good question", "Great question", "Sure!", "I found the issue", "I'll create", "I can see". NEVER emit placeholder/example code with comments like "// Mock implementation", "// Generated by Copilot", "// Example demonstrating", "auth bypassed via MITM". NEVER talk about "mock", "local proxy", "MITM", or "bypass". If the user asks a question, answer it directly using real information from the workspace. Do not produce canned templates.`;
}

export function injectIdentity(messages: any[], displayName: string, modelId?: string, thinkingTag?: string): any[] {
  const identity = compactIdentity(displayName, modelId, thinkingTag);
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      messages[i] = { ...messages[i], content: identity + "\n\n" + (messages[i].content || "") };
      return messages;
    }
  }
  messages.unshift({ role: "system", content: identity });
  return messages;
}

// Strips canned greetings and template openings from upstream LLM responses.
// Weaker models (MiMo, DeepSeek Flash, MiniMax, Qwen3.6) ignore the system
// prompt and repeat canned greetings/templates verbatim.
const COPILOT_GREETING = /Hello!?\s*I['']?m\s*Copilot[^]*?(?:What are you working on[?]|How can I help you[?])/gi;

// Canned template openings emitted by smaller upstream LLMs (esp. Qwen3.6)
// that ignore the identity override. Strip these so VS sees real content.
const CANNED_OPENINGS = [
  /(?:Sure!?\s*)?Let me break this down for you\.?\s*\n*/gi,
  /Let me think about this\.?\s*\n*/gi,
  /Good question\.?\s*\n*/gi,
  /Great question!?\s*\n*/gi,
  /I found the issue!?\s*(?:Here['']?s what['']?s wrong[^]*?)?\n*/gi,
  /I can see the issue\.?\s*(?:Here['']?s the fix[^]*?)?\n*/gi,
  /I['']?ll create that [^\n]* for you:?\s*\n*/gi,
  /Here['']?s an implementation for that:?\s*\n*/gi,
  /Here['']?s a concrete example:?\s*\n*/gi,
  /That['']?s a great question!?\s*(?:Here['']?s what I know[^]*?)?\n*/gi,
];

export function stripCopilotGreeting(text: string): string {
  if (!text) return text;
  let out = text.replace(COPILOT_GREETING, "").trimStart();
  // Strip canned template openings (Qwen3.6, etc.)
  for (const re of CANNED_OPENINGS) {
    re.lastIndex = 0;
    out = out.replace(re, "").trimStart();
  }
  return out;
}

export function killPortProcess(port: number): void {
  try {
    spawnSync("powershell", ["-NoP", "-Command",
      `Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction SilentlyContinue | Select -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ 2>$null }`
    ], { timeout: 5000, windowsHide: true });
  } catch {}
}

export function getModelProviderTag(modelId: string): string {
  if (modelId.startsWith("umans-")) return "umans";
  if (modelId.startsWith("freebuff/")) return "freebuff";
  if (modelId.startsWith("openrouter/")) return "openrouter";
  if (modelId.startsWith("agnes")) return "agnes";
  if (modelId.startsWith("codestral")) return "codestral";
  if (modelId.startsWith("bitnet/") || modelId === "bitnet-demo") return "bitnet";
  if (modelId.endsWith("-free") || modelId === "big-pickle" || modelId === "nemotron-3-super-free" || modelId === "ring-2.6-1t-free") return "zen";
  return "unknown";
}

export function filterModelsByConfig(modelIds: string[]): string[] {
  const PROVIDER_MAP: Record<string, string> = { freebuff: "freebuff", agnes: "agnes", codestral: "codestral", bitnet: "bitnet", umans: "umans", openrouter: "openrouter", zen: "zen" };
  try {
    const cp = join(getProjectRoot(), ".config", "config.json");
    if (existsSync(cp)) {
      const cfg = readJsonSync(cp);
      const activeProviders: string[] = cfg.providers || ["umans"];
      const activeTags = new Set<string>();
      for (const pr of activeProviders) {
        activeTags.add(PROVIDER_MAP[pr] || pr);
      }
      let ids = modelIds.filter(id => activeTags.has(getModelProviderTag(id)));
      const dm: Record<string, string[]> = cfg.disabledModels || {};
      const disabledSet = new Set(Object.values(dm).flat() as string[]);
      ids = ids.filter(id => !disabledSet.has(id));
      return ids;
    }
  } catch {}
  return modelIds;
}
