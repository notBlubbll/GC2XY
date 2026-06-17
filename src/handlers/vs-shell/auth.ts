// Unified VS-family auth handler — covers Visual Studio AND VS Team Explorer
// (aka "SQL Studio"). Both clients share the exact same OAuth flow, copilot
// user/token responses and content-exclusion endpoint — the only differences
// are the detection heuristic (editor-version vs user-agent) and whether
// chat requests are delegated to handleVisualStudio.
//
// This module replaces the duplicated auth code that previously lived in:
//   - handlers/vs/auth.ts          (VS Copilot Client, editor-version based)
//   - handlers/sql-studio/auth.ts  (VS Team Explorer, user-agent based)
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
  // 42% used: chat 290/500 remaining, completions 2320/4000 remaining
  return { chat: 290, completions: 2320 };
}

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

// Next month start at 00:00:00 UTC — matches GitHub's real quota_reset_date.
// Real captured token used 1783382400 = 2026-07-01T00:00:00Z for a 2026-06-17 request.
function getNextMonthStartUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function getNextMonthStartStr(): string {
  return getNextMonthStartUTC().toISOString().slice(0, 10);
}

function getNextMonthStartTS(): number {
  return Math.floor(getNextMonthStartUTC().getTime() / 1000);
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
  if (!isVSShell(headers)) return false;

  // Token exchange: VS client posts to /login/oauth/access_token
  if (method === "POST" && url.includes("/login/oauth/access_token")) return true;

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

// ── Copilot user ───────────────────────────────────────────────────────────

export function handleVSShellCopilotUser(req: HandlerInput): HandlerResult | null {
  const { method, url } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  const ghUser = getGithubUsername();
  const { copilot_plan, access_type_sku } = getSkuFromGh();
  const tid = generateTrackingId();
  const assignedDate = new Date(Date.now() - 12 * 86400000);
  const q = getRemainingQuota();
  const canUpgrade = access_type_sku === "free_limited_copilot" || access_type_sku === "copilot_for_individual";
  const resetDateStr = getNextMonthStartStr();
  const resetDateUtc = getNextMonthStartUTC().toISOString();
  const now = Date.now();
  const chatEnt = 500;
  const compEnt = 4000;
  function snapshot(id: string, remaining: number, entitlement: number, hasQuota: boolean) {
    const pct = entitlement > 0 ? Math.round((remaining / entitlement) * 1000) / 10 : 0;
    return {
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: pct,
      quota_id: id,
      quota_remaining: Number((remaining).toFixed(1)),
      unlimited: false,
      timestamp_utc: new Date(now).toISOString(),
      has_quota: hasQuota,
      quota_reset_at: 0,
      token_based_billing: true,
      remaining,
      entitlement,
    };
  }
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
      copilotignore_enabled: false,
      copilot_plan,
      editor_preview_features_enabled: true,
      is_mcp_enabled: true,
      is_staff: false,
      organization_login_list: [],
      organization_list: [],
      restricted_telemetry: false,
      cloud_session_storage_enabled: false,
      endpoints: {
        api: "https://api.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
      },
      token_based_billing: true,
      quota_reset_date: resetDateStr,
      quota_reset_date_utc: resetDateUtc,
      quota_snapshots: {
        chat: snapshot("chat", q.chat, chatEnt, true),
        completions: snapshot("completions", q.completions, compEnt, true),
        premium_interactions: {
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: 0.0,
          quota_id: "premium_interactions",
          quota_remaining: 0.0,
          unlimited: false,
          timestamp_utc: new Date(now).toISOString(),
          has_quota: false,
          quota_reset_at: 0,
          token_based_billing: true,
          remaining: 0,
          entitlement: 0,
        },
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
  const q = getRemainingQuota();
  const { sku } = getSkuFromGh();
  const resetTS = getNextMonthStartTS();
  const token = `tid=${tid};exp=${exp};iat=${iat};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=0;rt=1;ip=0.0.0.0;asn=AS000000;cq=${q.completions};rd=${resetTS}`;
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
      code_review_enabled: false,
      codesearch: true,
      copilotignore_enabled: false,
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
      limited_user_reset_date: resetTS,
      public_suggestions: "disabled",
      refresh_in: 1500,
      sku,
      telemetry: "disabled",
      token,
      tracking_id: tid,
      xcode: true,
      xcode_chat: false,
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
