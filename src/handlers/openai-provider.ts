// OpenAI-compatible provider helpers.
//
// The OC-GO upstream (opencode.ai/zen/go/v1) has been removed. Models that do
// not match a known provider prefix are now rejected with an "unknown model"
// error instead of being routed to the legacy OpenCode Go endpoint.
//
// This module still re-exports shared OpenAI client helpers (model context
// lookups, display name overrides, reasoning cache, tool normalization) so
// downstream handlers can keep importing them from one place.

import { isDebug } from "../split-console.ts";
import { getModelProviderTag } from "../shared.ts";

export {
  getModelCtx,
  getModelDisplayName,
  getModelFamily,
  modelHasVision,
  loadDisplayNameOverrides,
  setDisplayNameOverride,
  getDisplayNameOverride,
  initModelCtxMap,
  storeReasoning,
  injectCachedReasoning,
} from "./openai-client.ts";

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
  // Cheap inline hash (no crypto import needed for a logging fingerprint)
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

export { getModelProviderTag };

// ── No-op model init (OC-GO removed) ──
//
// Returns an empty list. Callers (models.ts aggregator, dashboard) treat this
// as "this provider contributes no models" and the model picker falls back to
// other providers (umans, agnes, codestral, freebuff, bitnet).

let _initialized = false;

export async function initModels(): Promise<string[]> {
  _initialized = true;
  return [];
}

export function getModelIds(): string[] {
  return [];
}

// Legacy Provider type kept for backwards-compatible imports.
export type Provider = "go" | "zen";

export function getProviderModelIds(_provider: Provider): string[] {
  return [];
}

// ── Chat completion (rejects unprefixed/unknown models) ──
//
// Handlers that previously fell through to `openAIChat(model, ...)` for models
// not matched by any provider prefix now hit this function and receive a
// synthetic 404 response describing the unknown model ID. The caller is
// expected to either fall back to a real provider (via routeChatWithFallback)
// or surface the error to the client.

export interface UnknownModelResponse {
  status: number;
  body: string;
  modelId: string;
}

function buildUnknownResponse(modelId: string): UnknownModelResponse {
  const body = JSON.stringify({
    error: {
      type: "unknown_model",
      message: `Unknown model id: ${modelId}`,
      model: modelId,
    },
  });
  return { status: 404, body, modelId };
}

export class UnknownModelError extends Error {
  status: number;
  modelId: string;
  constructor(modelId: string) {
    super(`Unknown model id: ${modelId}`);
    this.name = "UnknownModelError";
    this.status = 404;
    this.modelId = modelId;
  }
}

export async function chatCompletion(
  modelId: string,
  _messages: any[],
  _tools?: any[],
  _stream = true,
  _extra: Record<string, any> = {},
  _pinnedKeyIdx?: number,
  _sessionLabel?: string,
): Promise<Response> {
  // OC-GO upstream removed — unknown/unprefixed models are no longer routed
  // to opencode.ai/zen/go/v1. Callers should resolve a concrete provider
  // before invoking this function.
  if (isDebug()) console.log(`\n[OPENAI PROVIDER] rejected unknown model: ${modelId}`);
  const r = buildUnknownResponse(modelId);
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}
