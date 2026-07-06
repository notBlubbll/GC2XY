// Dedicated auth handler for GitHub Copilot Desktop App (User-Agent: undici / Node.js backend).
import forge from "node-forge";
import { jsonResponse, ghApiJsonResponse, HandlerInput, HandlerResult, getGithubUsername, getGithubDisplayName, getGithubSku } from "../../shared.ts";
import { trackRequest } from "../../usage-tracker.ts";

export function isCopilotDesktop(req: HandlerInput): boolean {
  const ua = (req.headers?.["user-agent"] || "").toLowerCase();
  return ua.includes("undici");
}

const YEAR10_S = 10 * 365 * 24 * 60 * 60;

function getSkuFields(): { copilot_plan: string; access_type_sku: string; sku: string; individual: boolean } {
  const sku = getGithubSku();
  switch (sku) {
    case "free":
    case "free_limited_copilot":
      return { copilot_plan: "individual", access_type_sku: "free_limited_copilot", sku: "free_limited_copilot", individual: true };
    case "pro":
    case "copilot_for_individual":
      return { copilot_plan: "individual", access_type_sku: "copilot_for_individual", sku: "copilot_for_individual", individual: true };
    case "business":
    case "copilot_for_business_seat":
      return { copilot_plan: "business", access_type_sku: "copilot_for_business_seat", sku: "copilot_for_business_seat", individual: false };
    case "max":
      return { copilot_plan: "max", access_type_sku: "max", sku: "max", individual: false };
    default:
      return { copilot_plan: "enterprise", access_type_sku: "copilot_enterprise_seat", sku: "copilot_enterprise_seat", individual: false };
  }
}

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function getRemainingQuota(): { chat: number; completions: number } {
  return { chat: 290, completions: 2320 };
}

function buildUserResponse() {
  const ghUser = getGithubUsername();
  const ghName = getGithubDisplayName();
  const q = getRemainingQuota();
  const { copilot_plan, access_type_sku, sku, individual } = getSkuFields();
  const reset = Math.floor(new Date("2120-01-01T00:00:00Z").getTime() / 1000);
  return {
    login: ghUser,
    id: 99999999,
    node_id: "U_kgDOAAAAAA",
    avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4",
    gravatar_id: "",
    url: `https://api.github.com/users/${ghUser}`,
    html_url: `https://github.com/${ghUser}`,
    type: "User",
    site_admin: false,
    name: ghName,
    company: null,
    blog: "",
    location: null,
    email: `${ghUser}@example.com`,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 42,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    access_type_sku,
    assigned_date: "2024-12-30T11:30:17+08:00",
    can_upgrade_plan: true,
    can_signup_for_limited: true,
    chat_enabled: true,
    chat_enabled_override: true,
    cli_enabled: true,
    copilot_plan,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
      "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
      proxy: "https://proxy.individual.githubcopilot.com",
      telemetry: "https://telemetry.individual.githubcopilot.com",
    },
    has_verified_contact_info: true,
    mau: false,
    analytics_tracking_id: generateTrackingId(),
    is_mcp_enabled: true,
    individual,
    limited_user_quotas: { chat: q.chat, completions: q.completions },
    limited_user_reset_date: "2120-01-01",
    limited_user_subscribed_day: 7,
    monthly_quotas: { chat: 500, completions: 4000 },
    public_code_suggestions: "block",
    sku,
  };
}

function buildTokenResponse() {
  const now = Math.floor(Date.now() / 1000);
  const tid = generateTrackingId();
  const exp = now + 3600 * 24 * 7;
  const iat = now;
  const reset = Math.floor(Date.now() / 1000) + YEAR10_S;
  const q = getRemainingQuota();
  const { sku, individual } = getSkuFields();
  return {
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
    copilotignore_enabled: false,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
      "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
      proxy: "https://proxy.individual.githubcopilot.com",
      telemetry: "https://telemetry.individual.githubcopilot.com",
    },
    expires_at: exp,
    iat,
    individual,
    limited_user_quotas: { chat: q.chat, completions: q.completions },
    limited_user_reset_date: reset,
    public_suggestions: "disabled",
    refresh_in: 1500,
    sku,
    telemetry: "disabled",
    ip: "0.0.0.0",
    asn: "AS000000",
    token: `tid=${tid};exp=${exp};iat=${iat};sku=${sku};proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=1;rt=1;cq=3934;ip=0.0.0.0;asn=AS000000;rd=${reset}`,
    tracking_id: tid,
    xcode: true,
    xcode_chat: false,
  };
}

function buildAccessToken(): string {
  return "gho_" + forge.util.bytesToHex(forge.random.getBytesSync(20));
}

export function handleCopilotDesktopAuth(req: HandlerInput): HandlerResult {
  trackRequest("desktop");
  const { method, url, body } = req;

  // POST /login/device/code - Device flow
  if (method === "POST" && url.includes("/login/device/code")) {
    console.log("\n[COPILOT DESKTOP] Device code request");
    const deviceCode = `desktop-device-code-${Date.now().toString(36)}`;
    return {
      handled: true,
      response: jsonResponse({
        device_code: deviceCode,
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    };
  }

  // POST /login/oauth/access_token
  if (method === "POST" && url.includes("/login/oauth/access_token")) {
    console.log("\n[COPILOT DESKTOP] OAuth access_token request");
    return {
      handled: true,
      response: jsonResponse({
        access_token: buildAccessToken(),
        token_type: "bearer",
        scope: "user,repo,gist,write:public_key,read:org,workflow",
        expires_in: 28800,
        refresh_token: buildAccessToken() + "_refresh",
      }),
    };
  }

  // GET /user
  if (method === "GET" && (url === "/user" || url.startsWith("/user?"))) {
    console.log("\n[COPILOT DESKTOP] /user request");
    return { handled: true, response: ghApiJsonResponse(buildUserResponse()) };
  }

  // GET /user/orgs
  if (method === "GET" && (url === "/user/orgs" || url.startsWith("/user/orgs?"))) {
    console.log("\n[COPILOT DESKTOP] /user/orgs request");
    return {
      handled: true,
      response: jsonResponse([{
        login: "fake-desktop-org",
        id: 99990001,
        node_id: "O_kgDOAAAAAQ",
        url: "https://api.github.com/orgs/fake-desktop-org",
        repos_url: "https://api.github.com/orgs/fake-desktop-org/repos",
        events_url: "https://api.github.com/orgs/fake-desktop-org/events",
        hooks_url: "https://api.github.com/orgs/fake-desktop-org/hooks",
        issues_url: "https://api.github.com/orgs/fake-desktop-org/issues",
        members_url: "https://api.github.com/orgs/fake-desktop-org/members{/member}",
        public_members_url: "https://api.github.com/orgs/fake-desktop-org/public_members{/member}",
        avatar_url: "https://avatars.githubusercontent.com/u/99990001?v=4",
        description: "Fake org for Copilot Desktop",
      }]),
    };
  }

  // GET /copilot_internal/user
  if (method === "GET" && url.includes("/copilot_internal/user")) {
    console.log("\n[COPILOT DESKTOP] /copilot_internal/user request");
    return { handled: true, response: ghApiJsonResponse(buildUserResponse()) };
  }

  // GET /copilot_internal/v2/token
  if (method === "GET" && url.startsWith("/copilot_internal/v2/token")) {
    console.log(`\n[COPILOT DESKTOP] /copilot_internal/v2/token request: ${url}`);
    return { handled: true, response: ghApiJsonResponse(buildTokenResponse(), 200, { "x-accepted-oauth-scopes": "repo" }) };
  }

  // GET /copilot_internal/content_exclusion
  if (method === "GET" && url.includes("/copilot_internal/content_exclusion")) {
    console.log(`\n[COPILOT DESKTOP] /copilot_internal/content_exclusion request`);
    return { handled: true, response: jsonResponse({ excluded_paths: [], excluded_content: [] }) };
  }

  // GET /copilot_internal/repository_search
  if (method === "GET" && url.includes("/copilot_internal/repository_search")) {
    const ghUser = getGithubUsername();
    console.log(`\n[COPILOT DESKTOP] /copilot_internal/repository_search request`);
    return {
      handled: true,
      response: jsonResponse({
        repositories: [{
          id: 1,
          name: "fake-repo",
          name_with_owner: `${ghUser}/fake-repo`,
          owner_login: ghUser,
          owner_type: "User",
          owner_avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4",
          is_private: false,
          visibility: "public",
          html_url: `https://github.com/${ghUser}/fake-repo`,
          description: "Fake repo for Copilot Desktop testing",
          language: "TypeScript",
          default_branch: "main",
        }],
        total_count: 1,
        incomplete_results: false,
      }),
    };
  }

  // POST /_alive
  if (method === "POST" && url === "/_alive") {
    console.log("[COPILOT DESKTOP] /_alive heartbeat");
    return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
  }

  return { handled: false };
}
