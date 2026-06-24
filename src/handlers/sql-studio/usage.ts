// Dedicated SSMS usage/quota handler.
//
// SSMS (SQL Server Management Studio) uses a different quota display format
// than VS Copilot Client. The real captured response (proxy mode) uses the
// full quota_snapshots structure with token_based_billing, quota_id,
// quota_remaining, timestamp_utc, has_quota, quota_reset_at fields — NOT the
// simple 6-field format that VS uses.
//
// This handler serves /copilot_internal/user and /copilot_internal/v2/token
// for SSMS clients with the recorded format but showing 42% used
// (chat 290/500, completions 2320/4000) to match VS.

import forge from "node-forge";
import { jsonResponse, HandlerInput, HandlerResult, getGithubUsername } from "../../shared.ts";
import { isSQLStudio } from "./auth.ts";

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function getSkuFromGh(): { copilot_plan: string; access_type_sku: string; sku: string } {
  // SSMS gets enterprise plan with limited quota_snapshots so usage
  // displays as 42%. MCP works because the proxy intercepts the
  // /mcp/registry API call and returns a valid response (the real API
  // returns 404 for enterprise users, which disables all MCP servers).
  return { copilot_plan: "enterprise", access_type_sku: "copilot_enterprise_seat", sku: "enterprise" };
}

// Enterprise plan: chat & completions are UNLIMITED (entitlement 0).
// Usage bar shows premium_interactions: 580/1000 = 42% used.
const PREM_REM = 580;
const PREM_ENT = 1000;

function unlimitedSnapshot(id: string) {
  return {
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 0,
    quota_id: id,
    quota_remaining: 0,
    unlimited: true,
    timestamp_utc: new Date().toISOString(),
    has_quota: false,
    quota_reset_at: 0,
    token_based_billing: true,
    remaining: 0,
    entitlement: 0,
  };
}

function premiumSnapshot() {
  const pct = Math.round((PREM_REM / PREM_ENT) * 1000) / 10;
  return {
    overage_count: 0,
    overage_permitted: true,
    percent_remaining: pct,
    quota_id: "premium_interactions",
    quota_remaining: Number(PREM_REM.toFixed(1)),
    unlimited: false,
    timestamp_utc: new Date().toISOString(),
    has_quota: true,
    quota_reset_at: 0,
    token_based_billing: true,
    remaining: PREM_REM,
    entitlement: PREM_ENT,
  };
}

function getNextMonthStartUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

// Build a full quota_snapshots entry matching the real recorded format.
// Real capture had: overage_count, overage_permitted, percent_remaining,
// quota_id, quota_remaining, unlimited, timestamp_utc, has_quota,
// quota_reset_at, token_based_billing, remaining, entitlement.

export function handleSSMSUser(req: HandlerInput): HandlerResult | null {
  const { method, url, headers } = req;
  if (method !== "GET" || !url.includes("/copilot_internal/user")) return null;
  if (!isSQLStudio(headers)) return null;
  const ghUser = getGithubUsername();
  const { copilot_plan, access_type_sku } = getSkuFromGh();
  const tid = generateTrackingId();
  const assignedDate = new Date(Date.now() - 12 * 86400000);
  const canUpgrade = access_type_sku === "free_limited_copilot" || access_type_sku === "copilot_for_individual";
  const resetDateStr = getNextMonthStartUTC().toISOString().slice(0, 10);
  const resetDateUtc = getNextMonthStartUTC().toISOString();
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
        chat: unlimitedSnapshot("chat"),
        completions: unlimitedSnapshot("completions"),
        premium_interactions: premiumSnapshot(),
      },
    }),
  };
}

export function handleSSMSToken(req: HandlerInput): HandlerResult | null {
  const { method, url, headers } = req;
  if (method !== "GET" || !url.startsWith("/copilot_internal/v2/token")) return null;
  if (!isSQLStudio(headers)) return null;
  const now = Math.floor(Date.now() / 1000);
  const tid = generateTrackingId();
  const exp = now + 1800;
  const iat = now;
  const resetTS = Math.floor(getNextMonthStartUTC().getTime() / 1000);
  const { sku } = getSkuFromGh();
  const token = `tid=${tid};exp=${exp};iat=${iat};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=0;rt=1;ip=0.0.0.0;asn=AS000000;cq=${PREM_REM};rd=${resetTS}`;
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

// Build x-quota-snapshot-* headers for SSMS chat completions.
// Enterprise: chat & completions unlimited (ent=0), premium_interactions 42% used.
export function buildSSMSQuotaSnapshotHeaders(): string {
  const rst = encodeURIComponent(getNextMonthStartUTC().toISOString());
  const premPct = Math.round((PREM_REM / PREM_ENT) * 1000) / 10;
  return [
    `x-quota-snapshot-chat: ent=0&ov=0.0&ovPerm=false&rem=0.0&rst=${rst}&totRem=0.0\r\n`,
    `x-quota-snapshot-completions: ent=0&ov=0.0&ovPerm=false&rem=0.0&rst=${rst}&totRem=0.0\r\n`,
    `x-quota-snapshot-premium_interactions: ent=${PREM_ENT}&ov=0.0&ovPerm=true&rem=${premPct}&rst=${rst}&totRem=${PREM_REM}.0\r\n`,
  ].join("");
}

export function handleSSMSUsage(req: HandlerInput): HandlerResult {
  let r: HandlerResult | null;
  r = handleSSMSUser(req);
  if (r) return r;
  r = handleSSMSToken(req);
  if (r) return r;
  return { handled: false };
}
