// Legacy OpenCode client.
//
// The OC-GO upstream (opencode.ai/zen/go/v1) has been removed. This module
// now re-exports shared helpers from openai-client.ts and rejects unprefixed
// models in chatCompletion(). It exists only for backwards-compatible imports
// (ollama-handler.ts); new code should import from openai-provider.ts /
// openai-client.ts directly.

import { isDebug } from "../split-console.ts";

export {
  storeReasoning,
  injectCachedReasoning,
  getModelCtx,
  modelHasVision,
  getModelDisplayName,
  getModelFamily,
  loadDisplayNameOverrides,
  setDisplayNameOverride,
  getDisplayNameOverride,
  initModelCtxMap,
} from "./openai-client.ts";

import { getModelProviderTag } from "../shared.ts";
export { getModelProviderTag };

// ── Session Tracking (logging-only, no upstream calls) ──

const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;

const conversationMap = new Map<string, { keyIdx: number; requestCount: number; sessNum: number }>();
let globalSessionCounter = 0;

export function extractUserPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return '';
  const text = (m: any) =>
    typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.find((p: any) => p?.type === 'text')?.text || '' : '');
  const user = [...messages].reverse().find((m: any) => m.role === 'user');
  if (!user) return '';
  return text(user).replace(/^\[[^\]]+\]\s*/, '');
}

export function fingerprintPayload(messages: any[]): string | null {
  if (!Array.isArray(messages)) return null;
  const text = (m: any) =>
    typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.find((p: any) => p?.type === 'text')?.text || '' : '');
  let idx = messages.findIndex((m: any) => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (idx < 0) idx = messages.findIndex((m: any) => m.role === 'user');
  if (idx < 0) return null;
  const raw = text(messages[idx]);
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, '');
  let h = 0;
  for (let i = 0; i < stripped.length; i++) {
    h = ((h << 5) - h + stripped.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 12);
}

export function detectSessionSignal(messages: any[]): { sessNum: number; keyIdx: number; keyLabel: string; sessionLabel: string } | null {
  const fingerprint = fingerprintPayload(messages);
  if (!fingerprint) return null;

  const entry = conversationMap.get(fingerprint);
  if (entry !== undefined) {
    entry.requestCount++;
    const label = `Key${entry.keyIdx + 1}`;
    const sessionLabel = `${label}|sess${entry.sessNum}`;
    return { sessNum: entry.sessNum, keyIdx: entry.keyIdx, keyLabel: label, sessionLabel };
  }

  const newEntry = { keyIdx: 0, requestCount: 1, sessNum: ++globalSessionCounter };
  conversationMap.set(fingerprint, newEntry);

  const keyLabel = `Key${newEntry.keyIdx + 1}`;
  const sessionLabel = `${keyLabel}|sess${newEntry.sessNum}`;

  return { sessNum: newEntry.sessNum, keyIdx: newEntry.keyIdx, keyLabel, sessionLabel };
}

// ── No-op model init (OC-GO removed) ──

let _initialized = false;

export async function initModels(): Promise<string[]> {
  _initialized = true;
  return [];
}

export function getModelIds(): string[] {
  return [];
}

export type Provider = "go" | "zen";

export function getProviderModelIds(_provider: Provider): string[] {
  return [];
}

export function getKeyStatus(): any[] {
  return [];
}

export function setKeys(_newKeys: string[]): void {
  // No-op — OC-GO upstream removed.
}

// ── Chat completion (rejects unknown models) ──

export async function chatCompletion(
  modelId: string,
  _messages: any[],
  _tools?: any[],
  _stream = true,
  _extra: Record<string, any> = {},
  _pinnedKeyIdx?: number,
  _sessionLabel?: string,
): Promise<Response> {
  if (isDebug()) console.log(`\n[OPENCODE CLIENT] rejected unknown model: ${modelId}`);
  const body = JSON.stringify({
    error: {
      type: "unknown_model",
      message: `Unknown model id: ${modelId}`,
      model: modelId,
    },
  });
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
