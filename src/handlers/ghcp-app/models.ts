import { jsonResponse, HandlerInput, HandlerResult, filterModelsByConfig } from "../../shared.ts";
import { getModelCtx, modelHasVision, getModelDisplayName } from "../openai-provider.ts";
import { getFreebuffModelPremium } from "../freebuff-client.ts";
import { addModels } from "../../models.ts";
import { isDebug } from "../../split-console.ts";

const GHCP_MODELS: any[] = [];
let _lastModelIds: string[] = [];
let _rebuilding = false;

function detectVendor(id: string): string {
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

function supportsThinkingVariants(id: string): boolean {
  const l = id.toLowerCase();
  const it = l.includes("glm") || l.includes("kimi") || l.includes("k2p") ||
    l.includes("minimax") || l.includes("qwen") || l.includes("big-pickle") || l.includes("hy3") ||
    l.includes("ring") || l.includes("nemotron");
  return l.includes("deepseek-v4") || (l.includes("mimo") && !it);
}

function modelSupports(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const base: any = { parallel_tool_calls: true, streaming: true, tool_calls: true };
  if (isChat) base.structured_outputs = true;
  if (isChat) base.vision = true;
  const supportsDeepThink = l.includes("deepseek") || l.includes("claude") || l.includes("mimo") ||
    l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini")) || l.includes("big-pickle");
  if (supportsDeepThink) {
    base.adaptive_thinking = true;
    base.min_thinking_budget = 1024;
    base.max_thinking_budget = l.includes("big-pickle") ? 64000 : 32000;
  }
  const internalThinking = l.includes("glm") || l.includes("kimi") || l.includes("k2p") ||
    l.includes("minimax") || l.includes("qwen") || l.includes("big-pickle") || l.includes("hy3") ||
    l.includes("ring") || l.includes("nemotron");
  if (l.includes("deepseek-v4")) {
    base.reasoning_effort = ["low", "medium", "high", "xhigh"];
  }
  if (l.includes("mimo") && !internalThinking) {
    base.reasoning_effort = ["low", "medium", "high"];
  }
  return base;
}

function modelLimits(id: string): any {
  const l = id.toLowerCase();
  const isChat = !l.includes("embedding") && !l.includes("ada");
  const limits: any = {};
  if (l.includes("big-pickle")) {
    limits.max_context_window_tokens = 1000000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 900000; limits.max_non_streaming_output_tokens = 64000;
  } else if (l.includes("deepseek") || l.includes("claude")) {
    limits.max_context_window_tokens = 200000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 200000; limits.max_non_streaming_output_tokens = 16000;
  } else if (l.includes("codex") || (l.match(/gpt-?5/) && !l.includes("mini"))) {
    limits.max_context_window_tokens = 400000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 272000; limits.max_non_streaming_output_tokens = 32000;
  } else if (l.includes("gpt-5-mini") || l.includes("gpt-5.4-mini") || l.includes("gpt-5.4-nano") || l.includes("gpt-5-nano")) {
    limits.max_context_window_tokens = 264000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 128000; limits.max_non_streaming_output_tokens = 16000;
  } else {
    limits.max_context_window_tokens = 128000; limits.max_output_tokens = 16384; limits.max_prompt_tokens = 64000; limits.max_non_streaming_output_tokens = 4096;
  }
  if (isChat) {
    limits.vision = { max_prompt_image_size: 3145728, max_prompt_images: 5, supported_media_types: ["image/jpeg", "image/png", "image/webp", "image/gif"] };
  }
  return limits;
}

function isFreeModel(id: string): boolean {
  return id.startsWith("agnes");
}

async function ensureModels() {
  if (_rebuilding) return;
  let modelIds = await addModels();
  modelIds = filterModelsByConfig(modelIds);

  const changed = modelIds.length !== _lastModelIds.length ||
    modelIds.some((id, i) => id !== _lastModelIds[i]);
  if (!changed && GHCP_MODELS.length > 0) return;
  _lastModelIds = [...modelIds];

  _rebuilding = true;
  GHCP_MODELS.length = 0;
  const seen = new Set<string>();

  const addModel = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const baseEmoji = id.startsWith("freebuff/") ? "[🇫🇷ᴇᴇ]" : supportsThinkingVariants(id) ? "💡" : "✨";
    const mediaEmoji = modelHasVision(id) ? "🎞️" : "";
    const limTag = id.startsWith("freebuff/") && getFreebuffModelPremium(id) ? " [LIM]" : "";
    const name = `${baseEmoji}${mediaEmoji}${limTag} ${getModelDisplayName(id)}`;
    const isLightweight = id.includes("mini") || id.includes("nano") || (id.includes("flash") && !id.includes("deepseek")) || id.includes("haiku") || id.includes("free");
    const isPowerful = id.includes("pro") || id.includes("opus") || id.includes("codex") || id.includes("omni") || (id.includes("flash") && id.includes("deepseek"));
    const limits = modelLimits(id);
    const free = isFreeModel(id);
    const baseModel: any = {
      id, object: "model",
      name, vendor: detectVendor(id), version: id, preview: false,
      model_picker_category: free ? "lightweight" : isLightweight ? "lightweight" : isPowerful ? "powerful" : "versatile",
      model_picker_enabled: true,
      is_chat_default: true,
      is_chat_fallback: true,
      billing: free ? { token_prices: { batch_size: 1000000, cache_price: 0, input_price: 0, output_price: 0 } } : { is_premium: true, multiplier: getModelCtx(id) || limits.max_context_window_tokens, restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"] },
      policy: { state: "enabled", terms: `Enable access to the ${id} model. [Learn more](https://opencode.ai)` },
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: id, object: "model_capabilities", type: "chat", tokenizer: "o200k_base",
        limits, supports: modelSupports(id),
      },
    };
    if (free) baseModel.model_picker_price_category = "low";
    GHCP_MODELS.push(baseModel);
  };

  for (const id of modelIds) addModel(id);
  if (isDebug()) console.log(`\n[MODEL CACHE] ghcp-app/models.ts rebuilt ${GHCP_MODELS.length} models`);
  _rebuilding = false;
}

export async function handleGHCPModels(req: HandlerInput): Promise<HandlerResult> {
  const { method, url } = req;
  if (method !== "GET") return { handled: false };
  if (url !== "/models" && !url.startsWith("/models?") && url !== "/v1/models" && !url.startsWith("/v1/models?")) {
    return { handled: false };
  }
  await ensureModels();
  return { handled: true, response: jsonResponse({ data: GHCP_MODELS, object: "list" }) };
}
