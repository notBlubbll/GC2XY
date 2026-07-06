// Model list for GitHub Copilot Desktop App (User-Agent: undici).
import { jsonResponse, HandlerInput, HandlerResult, filterModelsByConfig } from "../../shared.ts";
import { getModelCtx, modelHasVision, getModelDisplayName } from "../openai-provider.ts";
import { getFreebuffModelPremium } from "../freebuff-client.ts";
import { addModels } from "../../models.ts";

const DESKTOP_MODELS: any[] = [];
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

function modelLimits(id: string): any {
  const l = id.toLowerCase();
  const limits: any = {};
  if (l.includes("big-pickle")) {
    limits.max_context_window_tokens = 1000000; limits.max_output_tokens = 128000; limits.max_prompt_tokens = 900000;
  } else if (l.includes("deepseek") || l.includes("claude") || l.includes("codex")) {
    limits.max_context_window_tokens = 200000; limits.max_output_tokens = 64000; limits.max_prompt_tokens = 128000;
  } else {
    limits.max_context_window_tokens = 128000; limits.max_output_tokens = 16384; limits.max_prompt_tokens = 64000;
  }
  limits.vision = { max_prompt_image_size: 3145728, max_prompt_images: 5, supported_media_types: ["image/jpeg", "image/png", "image/webp"] };
  return limits;
}

function isFreeModel(id: string): boolean {
  return id.startsWith("agnes") || id.startsWith("pol/") || id.startsWith("freebuff/");
}

async function ensureModels() {
  if (_rebuilding) return;
  let modelIds = await addModels();
  modelIds = filterModelsByConfig(modelIds);

  const changed = modelIds.length !== _lastModelIds.length || modelIds.some((id, i) => id !== _lastModelIds[i]);
  if (!changed && DESKTOP_MODELS.length > 0) return;
  _lastModelIds = [...modelIds];

  _rebuilding = true;
  DESKTOP_MODELS.length = 0;
  const seen = new Set<string>();

  for (const id of modelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const baseEmoji = id.startsWith("freebuff/") ? "[🇫🇷ᴇᴇ]" : id.startsWith("pol/") ? "[ᴘᴏʟʟ]" : id.startsWith("agnes") ? "[ᴀɢɴᴇs]" : "✨";
    const mediaEmoji = modelHasVision(id) ? "🎞️" : "";
    const limTag = id.startsWith("freebuff/") && getFreebuffModelPremium(id) ? " [LIM]" : "";
    const name = `${baseEmoji}${mediaEmoji}${limTag} ${getModelDisplayName(id)}`.trim();
    const ctx = getModelCtx(id) || 128000;
    const free = isFreeModel(id);
    const l = id.toLowerCase();
    const isLightweight = l.includes("mini") || l.includes("nano") || l.includes("haiku") || l.includes("flash") || l.includes("free");
    const isPowerful = l.includes("pro") || l.includes("opus") || l.includes("codex") || l.includes("omni") || l.includes("sonnet");

    DESKTOP_MODELS.push({
      id,
      object: "model",
      name,
      vendor: detectVendor(id),
      version: id,
      preview: false,
      model_picker_category: free ? "lightweight" : isLightweight ? "lightweight" : isPowerful ? "powerful" : "versatile",
      model_picker_enabled: true,
      is_chat_default: !free && !isLightweight,
      is_chat_fallback: free || isLightweight,
      billing: free
        ? { token_prices: { batch_size: 1000000, cache_price: 0, input_price: 0, output_price: 0 } }
        : { is_premium: true, multiplier: ctx / 1000, restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"] },
      policy: { state: "enabled", terms: `Enable access to the ${id} model. [Learn more](https://opencode.ai)` },
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: id,
        object: "model_capabilities",
        type: "chat",
        tokenizer: "o200k_base",
        limits: modelLimits(id),
        supports: {
          parallel_tool_calls: true,
          streaming: true,
          tool_calls: true,
          structured_outputs: true,
          vision: modelHasVision(id),
        },
      },
    });
  }

  _rebuilding = false;
}

export async function handleCopilotDesktopModels(req: HandlerInput): Promise<HandlerResult> {
  const { method, url } = req;
  if (method !== "GET") return { handled: false };

  // GET /models or /v1/models
  if (url === "/models" || url.startsWith("/models?") || url === "/v1/models" || url.startsWith("/v1/models?")) {
    await ensureModels();
    console.log(`[COPILOT DESKTOP] /models list requested (${DESKTOP_MODELS.length} models)`);
    return { handled: true, response: jsonResponse({ data: DESKTOP_MODELS, object: "list" }) };
  }

  // GET /models/{id}
  const modelIdMatch = url.match(/\/(?:v1\/)?models\/([^?#]+)/);
  if (modelIdMatch) {
    let modelId = modelIdMatch[1].replace(/\/$/, "");
    await ensureModels();
    let model = DESKTOP_MODELS.find((m: any) => m.id === modelId);
    if (!model && modelId.includes("/")) {
      const shortId = modelId.split("/").pop() || modelId;
      model = DESKTOP_MODELS.find((m: any) => m.id === shortId);
    }
    if (model) {
      console.log(`[COPILOT DESKTOP] /models/${modelId} requested`);
      return { handled: true, response: jsonResponse(model) };
    }
    return { handled: true, response: jsonResponse({ error: "model not found", id: modelId }, 404) };
  }

  return { handled: false };
}
