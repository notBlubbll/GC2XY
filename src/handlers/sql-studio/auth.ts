import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult, getGithubSku, getGithubUsername } from "../../shared.ts";
import { trackRequest, getZenStats } from "../../usage-tracker.ts";
import { handleVSModels } from "../vs/models.ts";

function getSkuFromGh(): { copilot_plan: string; access_type_sku: string; sku: string } {
  const s = getGithubSku();
  switch (s) {
    case "free":
    case "free_limited_copilot": return { copilot_plan: "individual", access_type_sku: "free_limited_copilot", sku: "free_limited_copilot" };
    case "pro":
    case "copilot_for_individual": return { copilot_plan: "individual", access_type_sku: "copilot_for_individual", sku: "copilot_for_individual" };
    case "business":
    case "copilot_for_business_seat": return { copilot_plan: "business", access_type_sku: "copilot_for_business_seat", sku: "business" };
    case "max": return { copilot_plan: "max", access_type_sku: "max", sku: "max" };
    default: return { copilot_plan: "enterprise", access_type_sku: "copilot_enterprise_seat", sku: "enterprise" };
  }
}

function getRemainingQuota(): { chat: number; completions: number } {
  const zs = getZenStats();
  if (!zs || !zs.loggedIn || (zs.cost + zs.balance) === 0) return { chat: 290, completions: 2320 };
  const usedPct = Math.max(0, Math.min(100, (zs.cost / (zs.cost + zs.balance)) * 100));
  const chatTotal = 500, completionsTotal = 4000;
  return { chat: chatTotal - Math.round(chatTotal * usedPct / 100), completions: completionsTotal - Math.round(completionsTotal * usedPct / 100) };
}

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

export function isSQLStudio(headers: Record<string, string>): boolean {
  const ua = headers?.["user-agent"] || "";
  return ua.startsWith("VSTeamExplorer-GitHub");
}

export function handleSQLStudioCopilotUser(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  const ghUser = getGithubUsername();
  const { copilot_plan, access_type_sku } = getSkuFromGh();
  const tid = generateTrackingId();
  const assignedDate = new Date(Date.now() - 12 * 86400000);
  const q = getRemainingQuota();
  const canUpgrade = access_type_sku === "free_limited_copilot" || access_type_sku === "copilot_for_individual";
  return { handled: true, response: jsonResponse({
    login: ghUser,
    access_type_sku,
    analytics_tracking_id: tid,
    assigned_date: assignedDate.toISOString(),
    can_signup_for_limited: canUpgrade,
    can_upgrade_plan: canUpgrade,
    chat_enabled: true,
    cli_enabled: true,
    copilotignore_enabled: true,
    copilot_plan,
    editor_preview_features_enabled: true,
    is_mcp_enabled: true,
    organization_login_list: [],
    organization_list: [],
    restricted_telemetry: false,
    cloud_session_storage_enabled: true,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
      "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
      proxy: "https://proxy.individual.githubcopilot.com",
      telemetry: "https://telemetry.individual.githubcopilot.com",
    },
    quota_reset_date: "2120-01-01",
    limited_user_quotas: { chat: q.chat, completions: q.completions },
    quota_snapshots: {
      chat: { entitlement: 500, remaining: q.chat, percent_remaining: Math.round(q.chat / 500 * 100), unlimited: false, overage_permitted: false, overage_count: 0 },
      completions: { entitlement: 4000, remaining: q.completions, percent_remaining: Math.round(q.completions / 4000 * 100), unlimited: false, overage_permitted: false, overage_count: 0 },
      premium_interactions: { entitlement: 1000, remaining: 580, percent_remaining: 58, unlimited: true, overage_permitted: true, overage_count: 100 },
    },
  })};
}

export function handleSQLStudioToken(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.startsWith("/copilot_internal/v2/token")) return null;
  const now = Math.floor(Date.now() / 1000);
  const tid = generateTrackingId();
  const exp = now + 1800;
  const iat = now;
  const resetTs = Math.floor(new Date("2120-01-01T00:00:00Z").getTime() / 1000);
  const q = getRemainingQuota();
  const { sku } = getSkuFromGh();
  const token = `tid=${tid};exp=${exp};iat=${iat};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=0;rt=1;ip=0.0.0.0;asn=AS000000;cq=3934;rd=${resetTs}`;
  return { handled: true, response: jsonResponse({
    agent_mode_auto_approval: true,
    annotations_enabled: true,
    azure_only: false,
    blackbird_clientside_indexing: false,
    blackbird_external_indexing: true,
    chat_enabled: true,
    chat_jetbrains_enabled: true,
    code_quote_enabled: true,
    code_review_enabled: true,
    codesearch: true,
    copilotignore_enabled: true,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
      "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
      proxy: "https://proxy.individual.githubcopilot.com",
      telemetry: "https://telemetry.individual.githubcopilot.com",
    },
    expires_at: exp,
    iat,
    limited_user_quotas: { chat: q.chat, completions: q.completions },
    limited_user_reset_date: resetTs,
    quota_reset_date: resetTs,
    public_suggestions: "disabled",
    refresh_in: 1500,
    sku,
    telemetry: "disabled",
    token,
    tracking_id: tid,
  })};
}

export function handleSQLStudioContentExclusion(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/content_exclusion")) return null;
  return { handled: true, response: jsonResponse({ exclusions: [], scope: "all", enabled: false }) };
}

export async function handleSQLStudioAuth(req: HandlerInput): Promise<HandlerResult> {
  trackRequest("vs");
  const { headers } = req;
  if (!isSQLStudio(headers)) return { handled: false };
  let result: HandlerResult | null;
  result = handleSQLStudioCopilotUser(req);
  if (result) return result;
  result = handleSQLStudioToken(req);
  if (result) return result;
  result = handleSQLStudioContentExclusion(req);
  if (result) return result;
  const vsModelsResult = await handleVSModels(req);
  if (vsModelsResult.handled) return vsModelsResult;
  return { handled: false };
}
