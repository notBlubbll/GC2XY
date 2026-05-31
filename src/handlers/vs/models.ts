import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult } from "../../shared.ts";
import { initModels, getModelCtx, getModelDisplayName } from "../opencode-client.ts";
import { isDebug } from "../../split-console.ts";

const VS_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;

const THINKING_TAGS = ["LOW", "MEDIUM", "HIGH", "MAXIMUM"];
const TAG_PARAMS: Record<string, Record<string, string>> = {
  LOW: { reasoningEffort: "low" },
  MEDIUM: { reasoningEffort: "medium" },
  HIGH: { reasoningEffort: "high" },
  MAXIMUM: { reasoningEffort: "max" },
};
const SHORT_TAG: Record<string, string> = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX" };
const SMALL_CAPS: Record<string, string> = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ғ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "s", t: "ᴛ", u: "ᴜ", v: "v", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  A: "ᴀ", B: "ʙ", C: "ᴄ", D: "ᴅ", E: "ᴇ", F: "ғ", G: "ɢ", H: "ʜ", I: "ɪ",
  J: "ᴊ", K: "ᴋ", L: "ʟ", M: "ᴍ", N: "ɴ", O: "ᴏ", P: "ᴘ", Q: "ǫ", R: "ʀ",
  S: "s", T: "ᴛ", U: "ᴜ", V: "v", W: "ᴡ", X: "x", Y: "ʏ", Z: "ᴢ",
};
const toSc = (s: string) => s.split("").map(c => SMALL_CAPS[c] || c).join("");
const TAG_FITS: Record<string, string[]> = {
  LOW: ["low", "lo", "ʟ"].map(toSc),
  MEDIUM: ["medium", "med"].map(toSc).concat(["🇲🇩"]),
  HIGH: ["high", "hi", "ʜ"].map(toSc),
  MAXIMUM: ["maximum", "max"].map(toSc).concat(["🇲🇽"]),
};

function isPremium(id: string): boolean {
  const l = id.toLowerCase();
  return l.includes("opus") || l.includes("deepseek") || l.includes("codex") || l.includes("ultra") || l.includes("max");
}

function isThinkingModel(id: string): boolean {
  const l = id.toLowerCase();
  return l.includes("deepseek") || l.includes("claude") || l.includes("mimo") || l.includes("codex") || l.includes("big-pickle");
}

function getBilling(id: string, ctx: number): any {
  return {
    is_premium: true,
    multiplier: ctx,
    restricted_to: ["pro_plus", "business", "enterprise", "max"],
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
  return "Opencode";
}

export function getThinkingModes(id: string): string[] {
  const l = id.toLowerCase();
  if (l.includes("deepseek-v4")) return THINKING_TAGS;
  if (l.includes("mimo")) return ["LOW", "MEDIUM", "HIGH"];
  return [];
}

async function ensureModels() {
  if (_rebuilding) return;
  const models = await initModels();
  const changed = models.length !== _lastModelIds.length ||
    models.some((id, i) => id !== _lastModelIds[i]);
  if (!changed && VS_MODELS.length > 0) return;
  _lastModelIds = [...models];

  _rebuilding = true;
  VS_MODELS.length = 0;
  const seen = new Set<string>();

  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    let name = "✨" + getModelDisplayName(id);
    if (name.length > 17) name = name.replace(/\s/g, "");
    const modes = getThinkingModes(id);
    const picker = { category: "powerful" as const, enabled: true, chat_default: true, chat_fallback: false };
    const limits = getLimits(id);
    const realCtx = getModelCtx(id) || limits.max_context_window_tokens || 128000;
    limits.max_context_window_tokens = realCtx;
    const fakeMult = (realCtx / 100) + 0.01;
    const supports = getSupports(id);

    const model = {
      id,
      object: "model",
      name,
      vendor: detectVendor(id),
      version: id,
      preview: false,
      model_picker_category: picker.category,
      model_picker_enabled: picker.enabled,
      is_chat_default: picker.chat_default,
      is_chat_fallback: picker.chat_fallback,
      billing: getBilling(id, fakeMult),
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      capabilities: {
        family: id,
        object: "model_capabilities",
        type: "chat",
        tokenizer: "o200k_base",
        limits,
        supports,
      },
    };
    VS_MODELS.push(model);

    // Thinking tag variants
    for (const mode of modes) {
      const tag = SHORT_TAG[mode] || mode;
      const taggedId = `${id} [${tag}]`;
      if (seen.has(taggedId)) continue;
      seen.add(taggedId);
      const tagOptions = TAG_FITS[mode] || [tag.toLowerCase()];
      let displayName = name.replace(/\s/g, "").slice(1);
      let smallTag = tagOptions[0];
	  const prefix = "☆";
      let taggedName = `${prefix}${displayName}￤${smallTag}`;
      for (let ti = 1; ti < tagOptions.length && taggedName.length > 17; ti++) {
        smallTag = tagOptions[ti];
        taggedName = `${prefix}${displayName}￤${smallTag}`;
      }
      const tagSupports = { ...supports, reasoning_effort: [mode.toLowerCase()] };
      VS_MODELS.push({
        ...model,
        id: taggedId,
        name: taggedName,
        model_picker_category: "versatile",
        model_picker_enabled: true,
        is_chat_default: false,
        is_chat_fallback: false,
        billing: { is_premium: false, multiplier: fakeMult, restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"] },
        capabilities: { ...model.capabilities, supports: tagSupports },
      });

    }
  };

  for (const id of models) addModel(id);
  if (isDebug()) console.log(`\n[MODEL CACHE] vs/models.ts rebuilt ${VS_MODELS.length} models`);
  _rebuilding = false;
}

export async function handleVSModels(req: HandlerInput): Promise<HandlerResult> {
  const { method, url } = req;
  if (method !== "GET") return { handled: false };
  const isModelsEndpoint = url === "/models" || url.startsWith("/models?") || url === "/v1/models" || url.startsWith("/v1/models?");
  if (!isModelsEndpoint) return { handled: false };

  await ensureModels();
  return { handled: true, response: jsonResponse({ data: VS_MODELS, object: "list" }) };
}

export { ensureModels as ensureVSModels, VS_MODELS };
