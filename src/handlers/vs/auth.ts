import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult } from "../../shared.ts";

const YEAR10_S = 3600 * 24 * 365 * 10;
const YEAR10_MS = YEAR10_S * 1000;
const RESET_DATE_2500 = Math.floor(new Date("2500-01-01T00:00:00Z").getTime() / 1000);
const MONTHLY_QUOTA_CHAT = 500;
const MONTHLY_QUOTA_COMPLETIONS = 4000;

// VS OAuth app credentials (from VS 2026)
const VS_CLIENT_ID = "a200baed193bb2088a6e";
const VS_REDIRECT_URI_PREFIX = "vsweb+githubsi://authcode/";

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

export function isVisualStudio(headers: Record<string, string>): boolean {
  const editorVersion = headers?.["editor-version"] || "";
  // Match VS/VisualStudio/* (VS 2022+) or VS/<version> (VS Team Explorer, VS 2026 GHCP subprocess)
  return editorVersion.startsWith("VS/VisualStudio") || /^VS\/\d/.test(editorVersion);
}

// Check if request is part of the VS OAuth flow — must pass through to real GitHub
export function isVSOAuthFlow(req: HandlerInput): boolean {
  const { method, url, headers } = req;

  // Token exchange: VS client requests access_token
  if (method === "POST" && url.includes("/login/oauth/access_token") && isVisualStudio(headers)) {
    return true;
  }

  // Authorize: browser requests with VS-specific client_id or redirect_uri
  if (method === "GET" && url.includes("/login/oauth/authorize")) {
    const queryIdx = url.indexOf("?");
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx));
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      if (clientId === VS_CLIENT_ID || redirectUri.startsWith(VS_REDIRECT_URI_PREFIX)) {
        return true;
      }
    }
  }

  return false;
}

export function handleVSCopilotUser(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  const tid = generateTrackingId();
  const resetDate = new Date("2120-01-01T00:00:00Z");
  const resetStr = resetDate.toISOString().slice(0, 10);
  const assignedDate = new Date(Date.now() - 12 * 86400000);
  return { handled: true, response: jsonResponse({
    login: "fake-github-user",
    access_type_sku: "copilot_enterprise_seat",
    analytics_tracking_id: tid,
    assigned_date: assignedDate.toISOString(),
    can_signup_for_limited: false,
    chat_enabled: true,
    cli_enabled: true,
    cli_remote_control_enabled: true,
    copilotignore_enabled: true,
    copilot_plan: "enterprise",
    editor_preview_features_enabled: true,
    is_mcp_enabled: true,
    organization_login_list: [],
    organization_list: [],
    restricted_telemetry: false,
    cloud_session_storage_enabled: false,
    can_upgrade_plan: false,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
      "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
      proxy: "https://proxy.individual.githubcopilot.com",
      telemetry: "https://telemetry.individual.githubcopilot.com",
    },
    quota_reset_date: resetStr,
    quota_snapshots: {
      chat: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true, overage_permitted: false, overage_count: 0 },
      premium_interactions: { entitlement: 1000, remaining: 580, percent_remaining: 58, unlimited: true, overage_permitted: true, overage_count: 100 },
    },
  })};
}

export function handleVSToken(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.startsWith("/copilot_internal/v2/token")) return null;
  const now = Math.floor(Date.now() / 1000);
  const tid = generateTrackingId();
  const exp = now + 1800;
  const iat = now;
  const resetDate = new Date("2120-01-01T00:00:00Z");
  const resetTs = Math.floor(resetDate.getTime() / 1000);
    const token = `tid=${tid};exp=${exp};iat=${iat};sku=enterprise;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=1;rt=1;ip=91.200.103.13;asn=AS213250;cq=3934;rd=${resetTs}`;
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
    limited_user_quotas: { chat: 290, completions: 2320 },
    limited_user_reset_date: resetTs,
    quota_reset_date: resetTs,
    public_suggestions: "disabled",
    refresh_in: 1500,
    sku: "enterprise",
    telemetry: "disabled",
    token,
    tracking_id: tid,
  })};
}

export function handleVSContentExclusion(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/content_exclusion")) return null;
  return { handled: true, response: jsonResponse({ exclusions: [], scope: "all", enabled: false }) };
}

export function handleVSAuth(req: HandlerInput): HandlerResult {
  const { headers } = req;
  if (!isVisualStudio(headers)) return { handled: false };
  let result: HandlerResult | null;
  result = handleVSCopilotUser(req);
  if (result) return result;
  result = handleVSToken(req);
  if (result) return result;
  result = handleVSContentExclusion(req);
  if (result) return result;
  return { handled: false };
}
