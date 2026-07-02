import forge from "node-forge";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, HandlerInput, HandlerResult, getProjectRoot, filterModelsByConfig } from "../../shared.ts";
import { getModelCtx, getModelDisplayName, getModelProviderTag } from "../openai-provider.ts";

import { addModels } from "../../models.ts";
import { isDebug } from "../../split-console.ts";
import { getUmansThinkingModes } from "../umans-client.ts";
import { getVsLegacyModel } from "../dashboard-handler.ts";

const VS_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;

const THINKING_TAGS = ["LOW", "MEDIUM", "HIGH", "MAXIMUM"];
const LEVEL_SUFFIX: Record<string, string> = { LOW: "lo", MEDIUM: "md", HIGH: "hi", MAXIMUM: "mx" };
const TAG_FITS: Record<string, string[]> = {
  LOW: ["ʟᴏ", "ʟ"],
  MEDIUM: ["ᴍᴅ", "ᴍᴇᴅ"],
  HIGH: ["ʜɪ", "ʜ"],
  MAXIMUM: ["ᴍx", "ᴍᴀx"],
};

function isPremium(id: string): boolean {
  const l = id.toLowerCase();
  return l.includes("opus") || l.includes("deepseek") || l.includes("codex") || l.includes("ultra") || l.includes("max");
}

function isThinkingModel(id: string): boolean {
  const l = id.toLowerCase();
  return l.includes("deepseek") || l.includes("claude") || l.includes("mimo") || l.includes("codex") || l.includes("big-pickle");
}

function isFreeModel(id: string): boolean {
  return id.startsWith("agnes");
}

// ── Free model lightweight tuning ──
// model_picker_category: "lightweight" | model_picker_price_category: "low"
// is_chat_fallback: true  (eligible as auto-fallback)
//
// When switching to real GitHub token_prices format for Copilot Chat:
//   getBilling() → { token_prices: { input_price: 0, output_price: 0, cache_price: 0, batch_size: 1000000 } }
//   variant billing → same token_prices block (no is_premium/multiplier/restricted_to)

function getBilling(id: string, ctx: number): any {
  return {
    is_premium: true,
    multiplier: ctx,
    restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"],
  };
}

function getModelPicker(id: string): { category: string; enabled: boolean; chat_default: boolean; chat_fallback: boolean } {
  const l = id.toLowerCase();
  const premium = isPremium(id);
  if (l.includes("mini") || l.includes("nano") || l.includes("haiku") || l.includes("flash") || l.includes("free")) {
    return { category: "lightweight", enabled: true, chat_default: false, chat_fallback: true };
  }
  if (premium || l.includes("pro") || l.includes("opus") || l.includes("omni") || l.includes("codex") || l.includes("sonnet")) {
    // Premium models are hidden from picker by default but still accessible
    return { category: "powerful", enabled: !premium, chat_default: !premium, chat_fallback: false };
  }
  return { category: "versatile", enabled: true, chat_default: true, chat_fallback: false };
}

function getLimits(id: string): any {
  const l = id.toLowerCase();
  const limits: any = {};
  if (l.includes("big-pickle")) {
    limits.max_context_window_tokens = 1000000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 900000; limits.max_non_streaming_output_tokens = 64000;
  } else if (l.includes("deepseek") || l.includes("claude")) {
    limits.max_context_window_tokens = l.includes("opus") ? 144000 : 200000;
    limits.max_output_tokens = l.includes("opus") ? 64000 : 32000;
    limits.max_prompt_tokens = 128000;
    limits.max_non_streaming_output_tokens = 16000;
  } else if (l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini"))) {
    limits.max_context_window_tokens = 400000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 272000; limits.max_non_streaming_output_tokens = 32000;
  } else if (l.includes("gpt-5-mini") || l.includes("gpt-5.4-mini") || l.includes("gpt-5.4-nano") || l.includes("gpt-5-nano")) {
    limits.max_context_window_tokens = 264000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 128000; limits.max_non_streaming_output_tokens = 16000;
  } else {
    limits.max_context_window_tokens = 200000; limits.max_output_tokens = 16384; limits.max_prompt_tokens = 64000; limits.max_non_streaming_output_tokens = 4096;
  }
  const isChat = !l.includes("embedding") && !l.includes("ada");
  if (isChat) {
    limits.vision = {
      max_prompt_image_size: 3145728,
      max_prompt_images: l.includes("opus") ? 1 : 5,
      supported_media_types: ["image/jpeg", "image/png", "image/webp"],
    };
  }
  return limits;
}

function getSupports(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const base: any = { parallel_tool_calls: true, streaming: true, tool_calls: true };
  if (isChat) base.structured_outputs = true;
  if (isChat) base.vision = true;
  if (isThinkingModel(id)) {
    base.adaptive_thinking = true;
    base.min_thinking_budget = 1024;
    base.max_thinking_budget = l.includes("big-pickle") ? 64000 : 32000;
    // VS expects single reasoning_effort per model variant
    base.reasoning_effort = ["medium"];
  }
  const controllable = l.includes("deepseek-v4") || l.includes("mimo");
  if (controllable) {
    base.reasoning_effort = ["low", "medium", "high", "xhigh"];
  }
  return base;
}

export function detectVendor(id: string): string {
  const l = id.toLowerCase();
  if (l.startsWith("umans-")) return "UMANS";
  if (l.includes("deepseek") || l.includes("mimo")) return "OpenAI";
  if (l.includes("claude")) return "Anthropic";
  if (l.includes("gpt") || l.includes("codex") || l.includes("o1") || l.includes("o3")) return "OpenAI";
  if (l.includes("gemini")) return "Google";
  if (l.includes("minimax")) return "MiniMax";
  if (l.includes("kimi") || l.includes("k2p")) return "Moonshot AI";
  if (l.includes("qwen")) return "Alibaba Cloud";
  if (l.includes("glm")) return "Zhipu AI";
  if (l.includes("hy3")) return "H Company";
  if (l.includes("nemotron")) return "NVIDIA";
  if (l.includes("big-pickle")) return "Opencode";
  if (l.includes("ring")) return "Ring";
  if (l.includes("codestral") || l.includes("mistral")) return "Mistral AI";
  return "Opencode";
}

export function getThinkingModes(id: string): string[] {
  const l = id.toLowerCase();
  if (l.startsWith("freebuff/")) return [];
  // Consult the UMANS API catalog for models that advertise reasoning levels
  // (e.g. qwen, glm-5.2, deepseek-v4, mimo). This drives the clone variants.
  if (l.startsWith("umans-")) {
    const umansModes = getUmansThinkingModes(id);
    if (umansModes.length > 0) return umansModes;
  }
  if (l.includes("deepseek-v4")) return THINKING_TAGS;
  if (l.includes("mimo")) return ["LOW", "MEDIUM", "HIGH"];
  return [];
}

async function ensureModels() {
  if (_rebuilding) return;
  let models: string[];
  try {
    models = await addModels();
    models = filterModelsByConfig(models);
  } catch (e: any) {
    console.log(`[VS MODELS] addModels/filter failed: ${e.message}`);
    models = [];
  }
  // Fallback: ensure at least one model so VS doesn't get an empty list
  if (models.length === 0) {
    models = ["agnes-2.0-flash"];
    console.log("[VS MODELS] WARNING: no models from providers, using fallback: agnes-2.0-flash");
  }

  const changed = models.length !== _lastModelIds.length ||
    models.some((id, i) => id !== _lastModelIds[i]);
  if (!changed && VS_MODELS.length > 0) return;
  _lastModelIds = [...models];

  _rebuilding = true;
  VS_MODELS.length = 0;
  const seen = new Set<string>();

  try {
  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const free = isFreeModel(id);
    const prefix = id.startsWith("umans-") ? "✨" :
                   id.startsWith("bitnet/") || id === "bitnet-demo" ? "⚙️" :
                   id.startsWith("freebuff/") ? "🇫🇷ᴇᴇ" :
                   id.startsWith("agnes") ? "💜" :
                   id.startsWith("codestral/") ? "🌀" : "✨";
    let name = getModelDisplayName(id);
    if (name.length > 17) name = name.replace(/\s/g, "");
    const fullName = `${prefix}￤${name}`;
    const picker = { category: "powerful" as const, enabled: true, chat_default: true, chat_fallback: false };
    const limits = getLimits(id);
    const realCtx = getModelCtx(id) || limits.max_context_window_tokens || 128000;
    limits.max_context_window_tokens = realCtx;
    const fakeMult = (realCtx / 100) + 0.01;
    const supports = getSupports(id);
    const providerTag = getModelProviderTag(id);
    const pickerCategory = free ? "lightweight" :
                           providerTag === "bitnet" ? "others" :
                           picker.category;

    const model: any = {
      id,
      object: "model",
      name: fullName,
      vendor: detectVendor(id),
      version: id,
      preview: false,
      model_picker_category: pickerCategory,
      model_picker_enabled: true,
      is_chat_default: picker.chat_default,
      is_chat_fallback: free ? true : picker.chat_fallback,
      billing: getBilling(id, fakeMult),
      policy: { state: "enabled", terms: `Enable access to the ${id} model. [Learn more](https://opencode.ai)` },
    };
    model.supported_endpoints = ["/v1/messages", "/chat/completions", "/responses", "/completions", "ws:/responses"];
    model.capabilities = {
      family: id,
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      limits,
      supports,
    };
    VS_MODELS.push(model);

    // Thinking variants with -lo/-md/-hi/-mx suffix (only if model supports thinking)
    const modes = getThinkingModes(id);
    for (const mode of modes) {
      const suffix = LEVEL_SUFFIX[mode] || mode.toLowerCase();
      const taggedId = `${id}-${suffix}`;
      if (seen.has(taggedId)) continue;
      seen.add(taggedId);
      const baseName = name.replace(/\s/g, "");
      const tagOptions = TAG_FITS[mode] || [suffix.toUpperCase()];
      let smallTag = tagOptions[0];
      let taggedName = `${prefix}￤${baseName}￤${smallTag}`;
      for (let ti = 1; ti < tagOptions.length && taggedName.length > 17; ti++) {
        smallTag = tagOptions[ti];
        taggedName = `${prefix}￤${baseName}￤${smallTag}`;
      }
      const tagSupports = { ...supports, reasoning_effort: [mode.toLowerCase()] };
      const pushVariant: any = {
        ...model,
        id: taggedId,
        name: taggedName,
        model_picker_category: free ? "lightweight" : (providerTag === "bitnet" ? "others" : "versatile"),
        model_picker_enabled: true,
        is_chat_default: false,
        is_chat_fallback: false,
        billing: { is_premium: false, multiplier: fakeMult, restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"] },
        policy: { state: "enabled", terms: `Enable access to the ${id} model. [Learn more](https://opencode.ai)` },
        capabilities: { ...model.capabilities, supports: tagSupports },
      };
      VS_MODELS.push(pushVariant);
    }
  };

  for (const id of models) { try { addModel(id); } catch (e: any) { console.log(`[VS MODELS] addModel(${id}) failed: ${e.message}`); } }

  // Build separators by cloning a real model to avoid field mismatch
  const template = VS_MODELS.find((m: any) => !m.id.startsWith("_cat_") && !m.id.includes("[")) ;
  if (template && VS_MODELS.length > 0) {
    const SEP_ORDER = ["codestral", "freebuff", "agnes", "umans"];
    const PROVIDER_NAMES: Record<string, string> = {
      freebuff: "\u200D🇫🇷ᴇᴇ ⸻ FreeBuff:",
      agnes: "\u200D\u200D💜 ⸻ AgnesAI:",
      codestral: "\u200D\u200D\u200D🌀 ⸻ Codestral:",
      umans: "\u200D\u200D\u200D\u200D\u200D\u200D\u200D✨ ⸻ UMANS:",
    };
    // Header banner at very top
    VS_MODELS.splice(0, 0, {
      ...template,
      id: `_cat_header`,
      name: "⸻ Model (/Category) ⸻ ContextLength",
      is_chat_default: false,
      is_chat_fallback: false,
      model_picker_price_category: "unknown",
      billing: { ...template.billing, multiplier: 0 },
    });
    const seenTags: string[] = [];
    const others: any[] = [];
    for (let i = VS_MODELS.length - 1; i >= 0; i--) {
      const mid = VS_MODELS[i].id || "";
      if (mid.startsWith("cat_") || mid.startsWith("_cat_")) continue;
      const tag = getModelProviderTag(mid);
      if (tag === "bitnet") {
        others.unshift(VS_MODELS.splice(i, 1)[0]);
      }
      if (tag === "unknown") {
        VS_MODELS.splice(i, 1);
      }
    }
    for (let i = 0; i < VS_MODELS.length; i++) {
      const mid = VS_MODELS[i].id || "";
      if (mid.startsWith("cat_") || mid.startsWith("_cat_")) continue;
      const tag = getModelProviderTag(mid);
      if (!tag || tag === "bitnet" || seenTags.includes(tag)) continue;
      seenTags.push(tag);
      const displayName = PROVIDER_NAMES[tag] || tag.toUpperCase();
      VS_MODELS.splice(i, 0, {
        ...template,
        id: `cat_${tag}`,
        name: displayName,
        is_chat_default: false,
        is_chat_fallback: false,
        model_picker_price_category: "very_high",
        billing: { ...template.billing, multiplier: 0 },
      });
      i++;
    }
    if (others.length > 0) {
      VS_MODELS.push({
        ...template,
        id: `cat_others`,
        name: "\u200D\u200D\u200D\u200D\u200D\u200D\u200D⚙️ ⸻ Others:",
        model_picker_category: "others",
        is_chat_default: false,
        is_chat_fallback: false,
        model_picker_price_category: "very_high",
        billing: { ...template.billing, multiplier: 0 },
      });
      VS_MODELS.push(...others);
    }
  }

  if (isDebug()) console.log(`\n[MODEL CACHE] vs/models.ts rebuilt ${VS_MODELS.length} models (cats: ${VS_MODELS.filter((m:any) => typeof m.id === "string" && m.id.startsWith("cat_")).map((m:any) => m.id).join(", ") || "none"})`);
  console.log(`[VS MODELS] rebuilt ${VS_MODELS.length} models (default: ${VS_MODELS.find((m:any) => !String(m.id).startsWith("cat_") && !String(m.id).startsWith("_cat_"))?.id || "none"})`);
  } catch (e: any) {
    console.log(`[VS MODELS] rebuild failed: ${e.message}`);
  } finally {
  _rebuilding = false;
  }
}

// Return a flat model list (no category separators) for VS2022, which has no
// model picker dropdown. VS22's CopilotModelResolver needs a simple flat list
// with exactly one is_chat_default model — category separator entries
// (cat_*/_cat_*) confuse the resolver and can trigger "No model found".
// VS22 17.12 has a hardcoded list of "client supported models" (from the token
// response's SupportedModels field / compiled constants). It intersects these
// with the /models response. If the intersection is empty, CopilotModelResolver
// throws "No model found that matches the request." The FollowUpGenerator and
// other secondary intents (ExplainIntent, etc.) use these hardcoded IDs for
// lightweight tasks like generating follow-up suggestions.
//
// We inject alias entries for each VS22 hardcoded model ID so the intersection
// is non-empty. When VS22 sends a request with one of these IDs, resolveModel()
// in vs-legacy/index.ts maps it to the configured legacy model (e.g.
// umans-kimi-k2.7), so the actual upstream call uses a real model.
const VS22_CLIENT_MODELS: { id: string; category: string; fallback: boolean }[] = [
  { id: "gpt-4o",                category: "powerful",   fallback: false },
  { id: "gpt-4.1",               category: "powerful",   fallback: false },
  { id: "copilot-base",          category: "lightweight", fallback: true  },
  { id: "gpt-4o-mini",           category: "lightweight", fallback: true  },
  { id: "o1",                    category: "powerful",   fallback: false },
  { id: "o3-mini",               category: "lightweight", fallback: true  },
  { id: "claude-3.5-sonnet",     category: "powerful",   fallback: false },
  { id: "claude-3.7-sonnet",     category: "powerful",   fallback: false },
  { id: "gpt-4o-2024-11-20",     category: "powerful",   fallback: false },
  { id: "gpt-4.1-2025-04-14",    category: "powerful",   fallback: false },
  { id: "gpt-4o-2024-05-13",     category: "powerful",   fallback: false },
  { id: "gpt-4o-mini-2024-07-18", category: "lightweight", fallback: true  },
  { id: "o1-2024-12-17",         category: "powerful",   fallback: false },
  { id: "o3-mini-2025-01-31",    category: "lightweight", fallback: true  },
  { id: "claude-sonnet-4",       category: "powerful",   fallback: false },
];

export function getVSModelsFlat(): any[] {
  const flat = VS_MODELS.filter((m: any) => {
    const id = String(m.id || "");
    return !id.startsWith("cat_") && !id.startsWith("_cat_");
  }).map((m: any) => ({ ...m }));
  // VS22 override: flatten billing so CopilotModelResolver doesn't reject all
  // models as unaffordable. The context-length multiplier (2000+) is fine for
  // VS26 (display only) but VS22's resolver checks it against premium_interactions
  // quota and throws "No model found" when cost exceeds remaining quota.
  // Making all models is_premium:false avoids the premium_interactions check
  // entirely — the resolver skips affordability for non-premium models.
  for (const m of flat) {
    m.billing = { is_premium: false, multiplier: 1, restricted_to: [] };
  }
  // Ensure exactly one is_chat_default
  const legacyModelId = getVsLegacyModel();
  let defaultSet = false;
  if (legacyModelId) {
    for (const m of flat) m.is_chat_default = false;
    const match = flat.find((m: any) => m.id === legacyModelId);
    if (match) { match.is_chat_default = true; defaultSet = true; }
  }
  if (!defaultSet) {
    for (const m of flat) m.is_chat_default = false;
    if (flat.length > 0) flat[0].is_chat_default = true;
  }
  // Inject VS22 hardcoded client model IDs as aliases so the intersection
  // of client-supported × server-provided is non-empty. These are clones
  // of the default model with different IDs. resolveModel() maps them to
  // the real upstream model at request time.
  const template = flat.find((m: any) => m.is_chat_default) || flat[0];
  if (template) {
    const existingIds = new Set(flat.map((m: any) => m.id));
    for (const cm of VS22_CLIENT_MODELS) {
      if (existingIds.has(cm.id)) continue;
      flat.push({
        ...template,
        id: cm.id,
        name: cm.id,
        version: cm.id,
        vendor: "OpenAI",
        model_picker_category: cm.category,
        is_chat_default: false,
        is_chat_fallback: cm.fallback,
        billing: { is_premium: false, multiplier: 1, restricted_to: [] },
        policy: { state: "enabled", terms: `Enable access to the ${cm.id} model. [Learn more](https://opencode.ai)` },
      });
    }
  }
  return flat;
}

export async function handleVSModels(req: HandlerInput): Promise<HandlerResult> {
  const { method, url } = req;
  if (method !== "GET") return { handled: false };
  const isModelsEndpoint = url === "/models" || url.startsWith("/models?") || url === "/v1/models" || url.startsWith("/v1/models?");
  if (!isModelsEndpoint) return { handled: false };

  await ensureModels();
  const data = { data: VS_MODELS, object: "list" };
  const sepIds = VS_MODELS.filter((m: any) => typeof m.id === "string" && (m.id.startsWith("cat_") || m.id.startsWith("_cat_"))).map((m: any) => m.id + "=" + m.name);
  console.log(`[MODEL LIST] ${VS_MODELS.length} entries, separators: [${sepIds.join(", ") || "NONE"}]`);
  try { const fs = require("node:fs"); const p = require("node:path"); fs.writeFileSync(p.join(getProjectRoot(), ".cache", "vs-models-dump.json"), JSON.stringify(data, null, 2)); } catch {}
  return { handled: true, response: jsonResponse(data) };
}

export { ensureModels as ensureVSModels, VS_MODELS };
