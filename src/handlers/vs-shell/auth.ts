// Unified VS-family auth handler — covers Visual Studio AND VS Team Explorer
// (aka "SSMS"). Both clients share the exact same OAuth flow, copilot
// user/token responses and content-exclusion endpoint — the only differences
// are the detection heuristic (editor-version vs user-agent) and whether
// chat requests are delegated to handleVisualStudio.
//
// This module replaces the duplicated auth code that previously lived in:
//   - handlers/vs/auth.ts          (VS Copilot Client, editor-version based)
//   - handlers/ssms/auth.ts         (VS Team Explorer, user-agent based)
//
// Routing entry point: handleVSShell() — called first in the interceptor
// chain (before handleAuth), so VS-family requests get enterprise plan
// responses and OAuth token exchanges go to handleAuth instead of being
// swallowed by the VS chat handler's catch-all.

import forge from "node-forge";
import {
  jsonResponse,
  HandlerInput,
  HandlerResult,
  getGithubSku,
  getGithubUsername,
} from "../../shared.ts";
import { trackRequest } from "../../usage-tracker.ts";

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect a VS-family client by either signal:
 *  - editor-version header starting with "VS/VisualStudio" (VS Copilot Client)
 *  - editor-version header matching /^VS\/\d/ (VS Team Explorer legacy form)
 *  - editor-version header starting with "VS/SSMS" (SQL Server Management Studio)
 *  - user-agent containing "vsteamexplorer" (Octokit.net VS Team Explorer)
 *  - x-interaction-type containing "SSMSAgent" (SSMS Copilot provider)
 */
export function isVSShell(headers: Record<string, string>): boolean {
  const editorVersion = headers?.["editor-version"] || "";
  if (editorVersion.startsWith("VS/VisualStudio")) return true;
  if (editorVersion.startsWith("VS/SSMS")) return true;
  if (/^VS\/\d/.test(editorVersion)) return true;
  const ua = (headers?.["user-agent"] || "").toLowerCase();
  if (ua.includes("vsteamexplorer")) return true;
  const interactionType = headers?.["x-interaction-type"] || "";
  if (interactionType.includes("SSMSAgent")) return true;
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function getSkuFromGh(): { copilot_plan: string; access_type_sku: string; sku: string } {
  const s = getGithubSku();
  switch (s) {
    case "free":
    case "free_limited_copilot":
      return { copilot_plan: "individual", access_type_sku: "free_limited_copilot", sku: "free_limited_copilot" };
    case "pro":
    case "copilot_for_individual":
      return { copilot_plan: "individual", access_type_sku: "copilot_for_individual", sku: "copilot_for_individual" };
    case "business":
    case "copilot_for_business_seat":
      return { copilot_plan: "business", access_type_sku: "copilot_for_business_seat", sku: "business" };
    case "max":
      return { copilot_plan: "max", access_type_sku: "max", sku: "max" };
    default:
      return { copilot_plan: "enterprise", access_type_sku: "copilot_enterprise_seat", sku: "enterprise" };
  }
}

function getRemainingQuota(): { chat: number; completions: number } {
  // VS22 displays remaining as consumed, so return 42% remaining → shows "42% consumed"
  return { chat: 210, completions: 1680 };
}

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

// VS OAuth app credentials (from VS 2026) — used by isVSOAuthFlow passthrough check
export const VS_CLIENT_ID = "a200baed193bb2088a6e";
export const VS_REDIRECT_URI_PREFIX = "vsweb+githubsi://authcode/";

/**
 * True if the request is part of the VS OAuth browser/redirect flow.
 * These requests MUST be handled by handleAuth (which issues fake tokens)
 * — they must never reach the VS chat handler's catch-all, which returns
 * a token-less mock and breaks sign-in with VS error 723.
 */
export function isVSOAuthFlow(req: HandlerInput): boolean {
  const { method, url, headers } = req;

  // Token exchange: VS client posts to /login/oauth/access_token
  if (method === "POST" && url.includes("/login/oauth/access_token")) {
    // VS Team Explorer posts with its own user-agent; the browser may not
    if (isVSShell(headers)) return true;
    // Also accept form posts from the browser (in hybrid mode the browser
    // POSTs the access_token exchange on behalf of VS)
    return true;
  }

  // Authorize/select_account: browser requests with VS client_id in URL
  // The browser opens the OAuth URL — it has a Chrome UA, not VS headers.
  // We must check the client_id / redirect_uri in the query params instead.
  if (method === "GET" && (url.includes("/login/oauth/authorize") || url.includes("/login/oauth/select_account"))) {
    const queryIdx = url.indexOf("?");
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx));
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      if (clientId === VS_CLIENT_ID || redirectUri.startsWith(VS_REDIRECT_URI_PREFIX)) {
        return true;
      }
      // Also match localhost redirect_uri (VS 2022 uses http://localhost:PORT/)
      if (redirectUri.startsWith("http://localhost:") || redirectUri.startsWith("http://127.0.0.1:")) {
        return true;
      }
    }
  }

  // POST authorize_app / select_account form submissions (from browser)
  if (method === "POST" && (url.includes("/login/oauth/authorize_app") || url.includes("/login/oauth/select_account"))) {
    const queryIdx = url.indexOf("?");
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx));
      const clientId = params.get("client_id") || "";
      if (clientId === VS_CLIENT_ID) return true;
    }
    // Also check form body
    const formBody = req.body?.toString() || "";
    if (formBody.includes(`client_id=${VS_CLIENT_ID}`) || formBody.includes(`client_id=a200baed193bb2088a6e`)) {
      return true;
    }
  }

  return false;
}

// ── Copilot user ───────────────────────────────────────────────────────────

export function handleVSShellCopilotUser(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  const ghUser = getGithubUsername();
  const { copilot_plan, access_type_sku } = getSkuFromGh();
  const tid = generateTrackingId();
  const resetDate = new Date("2120-01-01T00:00:00Z");
  const resetStr = resetDate.toISOString().slice(0, 10);
  const assignedDate = new Date(Date.now() - 12 * 86400000);
  const q = getRemainingQuota();
  const canUpgrade = access_type_sku === "free_limited_copilot" || access_type_sku === "copilot_for_individual";
  return {
    handled: true,
    response: jsonResponse({
      login: ghUser,
      access_type_sku,
      analytics_tracking_id: tid,
      assigned_date: assignedDate.toISOString(),
      can_signup_for_limited: canUpgrade,
      can_upgrade_plan: canUpgrade,
      chat_enabled: true,
      cli_enabled: true,
      cli_remote_control_enabled: true,
      copilotignore_enabled: copilot_plan !== "individual",
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
      quota_reset_date: resetStr,
      limited_user_quotas: { chat: q.chat, completions: q.completions },
      quota_snapshots: {
        chat: { entitlement: 500, remaining: q.chat, percent_remaining: Math.round(q.chat / 500 * 100), unlimited: false, overage_permitted: false, overage_count: 0 },
        completions: { entitlement: 4000, remaining: q.completions, percent_remaining: Math.round(q.completions / 4000 * 100), unlimited: false, overage_permitted: false, overage_count: 0 },
        premium_interactions: { entitlement: 1000, remaining: 580, percent_remaining: 58, unlimited: true, overage_permitted: true, overage_count: 100 },
      },
    }),
  };
}

// ── Copilot token ──────────────────────────────────────────────────────────

export function handleVSShellToken(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.startsWith("/copilot_internal/v2/token")) return null;
  const now = Math.floor(Date.now() / 1000);
  const tid = generateTrackingId();
  const exp = now + 1800;
  const iat = now;
  const resetDate = new Date("2120-01-01T00:00:00Z");
  const resetTs = Math.floor(resetDate.getTime() / 1000);
  const q = getRemainingQuota();
  const { sku, copilot_plan } = getSkuFromGh();
  const isEnterprise = copilot_plan !== "individual";
  const token = `tid=${tid};exp=${exp};iat=${iat};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=0;rt=1;ip=0.0.0.0;asn=AS000000;cq=3934;rd=${resetTs}`;
  return {
    handled: true,
    response: jsonResponse({
      agent_mode_auto_approval: true,
      annotations_enabled: true,
      azure_only: false,
      blackbird_clientside_indexing: false,
      blackbird_external_indexing: true,
      chat_enabled: true,
      chat_jetbrains_enabled: true,
      code_quote_enabled: true,
      code_review_enabled: isEnterprise,
      codesearch: true,
      copilotignore_enabled: isEnterprise,
      endpoints: {
        api: "https://api.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
      },
      expires_at: exp,
      iat,
      individual: true,
      limited_user_quotas: { chat: q.chat, completions: q.completions },
      limited_user_reset_date: resetTs,
      public_suggestions: "disabled",
      refresh_in: 1500,
      sku,
      telemetry: "disabled",
      token,
      tracking_id: tid,
    }),
  };
}

// ── Content exclusion ──────────────────────────────────────────────────────

export function handleVSShellContentExclusion(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/content_exclusion")) return null;
  // Real GitHub returns 404 for free-tier users — VS handles this gracefully.
  // Returning 200 with a JSON body caused CopilotExclusionRulesLoader to throw
  // a deserialization error, which made VS exclude ALL files and fail chat.
  return {
    handled: true,
    response: jsonResponse(
      { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" },
      404,
    ),
  };
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Unified auth handler for all VS-family clients (VS Copilot Client + VS
 * Team Explorer). Handles the copilot_internal/* endpoints that both
 * clients share. Returns {handled:false} for OAuth/login routes so
 * handleAuth (which issues fake gho_* tokens) can take them — this is
 * critical: the VS chat handler's catch-all would otherwise swallow
 * /login/oauth/access_token with a token-less mock, breaking sign-in.
 */
export function handleVSShell(req: HandlerInput): HandlerResult {
  trackRequest("vs");
  const { headers } = req;
  if (!isVSShell(headers)) return { handled: false };

  // OAuth/login flow must fall through to handleAuth — never short-circuit
  if (isVSOAuthFlow(req)) return { handled: false };

  let result: HandlerResult | null;
  result = handleVSShellCopilotUser(req);
  if (result) return result;
  result = handleVSShellToken(req);
  if (result) return result;
  result = handleVSShellContentExclusion(req);
  if (result) return result;

  return { handled: false };
}
