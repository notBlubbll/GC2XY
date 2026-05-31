import forge from "node-forge";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const _ARGS = new Set(typeof process !== "undefined" ? process.argv.slice(1) : []);
if (_ARGS.has("--mode-3") || process.env.gc2xy_MODE === "proxy") _currentMode = "proxy";
else if (_ARGS.has("--mode-2") || process.env.gc2xy_MODE === "hybrid") _currentMode = "hybrid";

export function getMode(): ProxyMode { return _currentMode; }
export function setMode(m: ProxyMode) { _currentMode = m; }
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
