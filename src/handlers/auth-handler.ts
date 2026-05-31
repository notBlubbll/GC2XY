import forge from "node-forge";
import { jsonResponse, htmlResponse, HttpResponse, HandlerInput, HandlerResult, getMode, isHybrid } from "../shared.ts";
import { handleVSAuth } from "./vs/auth.ts";
import { trackRequest, getZenStats } from "../usage-tracker.ts";

const ENABLED = process.env.FAKE_DEVICE_LOGIN !== "0";
const FAKE_USER_CODE = process.env.FAKE_USER_CODE || "ABCD-1234";
const FAKE_ACCESS_TOKEN = process.env.FAKE_ACCESS_TOKEN || "gho_" + forge.util.bytesToHex(forge.random.getBytesSync(20));
const FAKE_TOKEN_TYPE = "bearer";
const FAKE_SCOPE = "repo,gist,user,workflow,copilot";
const YEAR10_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const YEAR10_S = 10 * 365 * 24 * 60 * 60;

const activeDevices = new Map<string, { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number; status: "pending" | "authorized" | "expired"; createdAt: number }>();
const authCodes = new Map<string, { code: string; clientId: string; redirectUri: string; scope: string; createdAt: number }>();
let deviceCodeCounter = 0;
let authCodeCounter = 0;

function getRemainingQuota(): { chat: number; completions: number } {
  const zs = getZenStats();
  if (!zs || !zs.loggedIn || (zs.cost + zs.balance) === 0) return { chat: 210, completions: 1680 };
  const usedPct = Math.max(0, Math.min(100, (zs.cost / (zs.cost + zs.balance)) * 100));
  const chatTotal = 500, completionsTotal = 4000;
  const usedChat = Math.round(chatTotal * usedPct / 100);
  return { chat: chatTotal - usedChat, completions: completionsTotal - Math.round(completionsTotal * usedPct / 100) };
}

function generateDeviceCode(): string {
  deviceCodeCounter++;
  return `fake-device-code-${deviceCodeCounter}-${Date.now().toString(36)}`;
}

function initDeviceLogin() {
  const deviceCode = generateDeviceCode();
  const entry = { deviceCode, userCode: FAKE_USER_CODE, verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5, status: "pending" as const, createdAt: Date.now() };
  activeDevices.set(deviceCode, entry);
  return entry;
}

function generateVerificationPage(userCode: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Device Login - GitHub</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
<div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 40px; max-width: 500px; text-align: center;">
  <h1 style="margin-bottom: 8px;">Device Activation</h1>
  <p style="color: #8b949e; margin-bottom: 24px;">Enter the code displayed on your device</p>
  <div style="background: #0d1117; border: 1px dashed #58a6ff; border-radius: 6px; padding: 24px; margin-bottom: 24px;">
    <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #58a6ff; font-family: monospace;">${userCode}</div>
  </div>
  <p style="font-size: 12px; color: #8b949e;">This is a FAKE device login page created by MITM Debug Proxy.</p>
  <p style="font-size: 12px; color: #8b949e;">The code above will automatically be accepted within 5 seconds.</p>
</div>
<script>
  setTimeout(() => {
    fetch('/login/device/verify-fake', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: '${userCode}'}) })
      .then(r => r.json()).then(d => { if(d.ok) { location.reload(); } }).catch(() => {});
  }, 3000);
</script>
</body></html>`;
}

function generateCopilotToken(): string {
  const tid = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 7;
  const iat = Math.floor(Date.now() / 1000);
  const reset = Math.floor(Date.now() / 1000) + YEAR10_S;
  return `tid=${tid};exp=${exp};iat=${iat};sku=free_limited_copilot;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=0;client_byok=1;rt=1;cq=3934;ip=91.200.103.13;asn=AS213250;rd=${reset}`;
}

function generateTrackingId(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function mitmMode(): string {
  return getMode();
}

export function handleAuth(req: HandlerInput): HandlerResult {
  trackRequest("auth");
  if (!ENABLED) return { handled: false };
  const { method, url, body, headers } = req;
  const isHybridMode = isHybrid();
  const isVsOAuth = url.includes("vsweb+githubsi://") || url.includes("vsweb%2Bgithubsi%3A%2F%2F") || url.includes("client_id=a200baed193bb2088a6e");
  const isBrowser = (headers?.["accept"] || "").includes("text/html");

  // ✨ ALWAYS return JSON for api.github.com/ — checked first, before hybrid passthrough
  if (method === "GET" && url === "/") {
    const hostHeader = req.headers?.["host"] || "";
    const hostname = req.hostname || "";
    if (hostHeader.startsWith("api.github.com") || hostname === "api.github.com") {
      return { handled: true, response: jsonResponse({
        mitm_status: "active",
        mitm_mode: mitmMode(),
        current_user_url: "https://api.github.com/user",
        current_user_authorizations_html_url: "https://github.com/settings/connections/applications{/client_id}",
        authorizations_url: "https://api.github.com/authorizations",
        code_search_url: "https://api.github.com/search/code?q={query}{&page,per_page,sort,order}",
        commit_search_url: "https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}",
        emails_url: "https://api.github.com/user/emails",
        emojis_url: "https://api.github.com/emojis",
        events_url: "https://api.github.com/events",
        feeds_url: "https://api.github.com/feeds",
        followers_url: "https://api.github.com/user/followers",
        following_url: "https://api.github.com/user/following{/target}",
        gists_url: "https://api.github.com/gists{/gist_id}",
        hub_url: "https://api.github.com/hub",
        issue_search_url: "https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}",
        issues_url: "https://api.github.com/issues",
        keys_url: "https://api.github.com/user/keys",
        label_search_url: "https://api.github.com/search/labels?q={query}&repository_id={repository_id}{&page,per_page}",
        notifications_url: "https://api.github.com/notifications",
        organization_url: "https://api.github.com/orgs/{org}",
        organization_repositories_url: "https://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}",
        organization_teams_url: "https://api.github.com/orgs/{org}/teams",
        public_gists_url: "https://api.github.com/gists/public",
        rate_limit_url: "https://api.github.com/rate_limit",
        repository_url: "https://api.github.com/repos/{owner}/{repo}",
        repository_search_url: "https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}",
        current_user_repositories_url: "https://api.github.com/user/repos{?type,page,per_page,sort}",
        starred_url: "https://api.github.com/user/starred{/owner}{/repo}",
        starred_gists_url: "https://api.github.com/gists/starred",
        topic_search_url: "https://api.github.com/search/topics?q={query}{&page,per_page}",
        user_url: "https://api.github.com/users/{user}",
        user_organizations_url: "https://api.github.com/user/orgs",
        user_repositories_url: "https://api.github.com/users/{user}/repos{?type,page,per_page,sort}",
        user_search_url: "https://api.github.com/search/users?q={query}{&page,per_page,sort,order}",
      })};
    }
  }

  if (isHybridMode && isBrowser && method === "GET" && !isVsOAuth) {
    return { handled: false };
  }

  // VS-specific auth responses (enterprise plan) — checked before regular handlers
  const vsResult = handleVSAuth(req);
  if (vsResult.handled) return vsResult;

  // POST /login/device/code - Device authorization request
  if (method === "POST" && url.includes("/login/device/code")) {
    console.log("\n[FAKE DEVICE LOGIN] Intercepting device code request...");
    const device = initDeviceLogin();
    activeDevices.set(device.deviceCode, { ...device, status: "authorized" });
    console.log(`[FAKE DEVICE LOGIN] Device code ${device.deviceCode} created and auto-authorized!`);
    return { handled: true, response: jsonResponse({
      device_code: device.deviceCode, user_code: device.userCode,
      verification_uri: device.verificationUri, expires_in: device.expiresIn, interval: device.interval,
    })};
  }

  // POST /login/oauth/authorize_app - App authorization (real OAuth app grant)
  if (method === "POST" && url.includes("/login/oauth/authorize_app")) {
    console.log(`\n[FAKE GHE] Intercepting app authorization request`);
    const queryIdx = url.indexOf("?");
    const params = queryIdx >= 0 ? new URLSearchParams(url.slice(queryIdx)) : new URLSearchParams();
    const redirectUri = params.get("redirect_uri") || "github-app://oauth/callback";
    const state = params.get("state") || "";
    const clientId = params.get("client_id") || "";
    const scope = params.get("scope") || "repo";
    // Redirect back to authorize (without prompt=select_account) to generate code + HTML page
    const authorizeUrl = `/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}`;
    console.log(`[FAKE GHE] Redirecting to authorize: ${authorizeUrl}`);
    return { handled: true, response: { statusCode: 302, headers: { location: authorizeUrl, "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/oauth/select_account - OAuth account picker
  if (method === "GET" && url.includes("/login/oauth/select_account")) {
    console.log(`\n[FAKE GHE] Intercepting OAuth account picker`);
    const queryIdx = url.indexOf("?");
    const params = queryIdx >= 0 ? new URLSearchParams(url.slice(queryIdx)) : new URLSearchParams();
    const redirectUri = params.get("redirect_uri") || "";
    const state = params.get("state") || "";
    const clientId = params.get("client_id") || "";
    const scope = params.get("scope") || "";
    return {
      handled: true,
      response: htmlResponse(`<!DOCTYPE html>
<html lang="en" class="html-auth" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">
<head><meta charset="utf-8"><title>Authorize OAuth App - GitHub</title>
<meta name="viewport" content="width=device-width">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:32px;max-width:420px;text-align:center}
.card h1{font-size:20px;margin:0 0 4px}
.card .sub{color:#8b949e;font-size:12px;margin:0 0 20px}
.user{display:flex;align-items:center;gap:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:20px;text-align:left;cursor:pointer}
.user:hover{border-color:#58a6ff}
.user img{width:40px;height:40px;border-radius:50%}
.user .un{font-weight:600;font-size:14px}
.user .un2{color:#8b949e;font-size:12px}
.btn{display:block;width:100%;background:#238636;color:#fff;border:none;border-radius:6px;padding:8px;font-size:14px;cursor:pointer;text-decoration:none}
.btn:hover{background:#2ea043}
.cancel{display:block;width:100%;background:transparent;color:#8b949e;border:1px solid #30363d;border-radius:6px;padding:8px;font-size:14px;cursor:pointer;margin-top:8px;text-decoration:none}
.cancel:hover{border-color:#8b949e;color:#e6edf3}
</style></head>
<body><div class="card">
<h1>Choose an account</h1>
<p class="sub">to continue to <strong>Visual Studio</strong></p>
<form method="POST" action="${url}">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="scope" value="${scope}">
<button type="submit" class="user" style="display:flex;align-items:center;gap:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:20px;text-align:left;cursor:pointer;width:100%;color:inherit;font:inherit">
<img src="https://avatars.githubusercontent.com/u/99999999?v=4" alt="" onerror="this.style.display='none'">
<div><div class="un">Fake Github User</div><div class="un2">fake-github-user</div></div>
</button>
</form>
<a href="#" class="cancel">Cancel</a>
</div></body></html>`),
    };
  }

  // POST /login/oauth/select_account - Account picker form submission
  if (method === "POST" && url.includes("/login/oauth/select_account")) {
    console.log(`\n[FAKE GHE] Account picker form submitted`);
    const formBody = body?.toString() || "";
    const formParams = new URLSearchParams(formBody);
    const clientId = formParams.get("client_id") || "";
    const redirectUri = formParams.get("redirect_uri") || "";
    const state = formParams.get("state") || "";
    const scope = formParams.get("scope") || "";
    const authorizeUrl = `/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}`;
    return { handled: true, response: { statusCode: 302, headers: { location: authorizeUrl, "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/oauth/authorize - OAuth authorization (PKCE)
  if (method === "GET" && url.includes("/login/oauth/authorize")) {
    console.log(`\n[FAKE GHE] Intercepting OAuth authorize request`);
    const queryIdx = url.indexOf("?");
    const params = queryIdx >= 0 ? new URLSearchParams(url.slice(queryIdx)) : new URLSearchParams();
    const prompt = params.get("prompt") || "";
    const redirectUri = params.get("redirect_uri") || "github-app://oauth/callback";
    const state = params.get("state") || "";
    const clientId = params.get("client_id") || "";
    const scope = params.get("scope") || "repo";

    // If prompt=select_account, redirect to the account picker first
    if (prompt === "select_account") {
      const selectUrl = `/login/oauth/select_account?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}&prompt=select_account`;
      return { handled: true, response: { statusCode: 302, headers: { location: selectUrl, "cache-control": "no-store" }, body: Buffer.alloc(0) } };
    }

    // Generate a fake auth code and return HTML with meta refresh (matches real GitHub format)
    authCodeCounter++;
    const fakeCode = `fake-auth-code-${authCodeCounter}-${forge.util.bytesToHex(forge.random.getBytesSync(4))}`;
    const fakeSessionId = forge.util.bytesToHex(forge.random.getBytesSync(32));
    authCodes.set(fakeCode, { code: fakeCode, clientId, redirectUri, scope, createdAt: Date.now() });
    console.log(`[FAKE GHE] Generated auth code: ${fakeCode} for client: ${clientId}`);
    const callbackUrl = `${redirectUri}?browser_session_id=${fakeSessionId}&code=${fakeCode}&state=${state}`;
    return {
      handled: true,
      response: htmlResponse(`<!DOCTYPE html>
<html lang="en" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">
<head><meta charset="utf-8">
<title>OAuth application authorized</title>
<meta http-equiv="refresh" content="0;url=${callbackUrl}" data-url="${callbackUrl}">
<meta name="viewport" content="width=device-width">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center}
</style></head>
<body><p>Redirecting to application...</p></body></html>`),
    };
  }

  // POST /login/oauth/access_token - Token exchange
  if (method === "POST" && url.includes("/login/oauth/access_token")) {
    const rawBody = body?.toString() || "";
    // Try form-urlencoded first, then JSON
    let params: Record<string, string> = {};
    try {
      const sp = new URLSearchParams(rawBody);
      for (const [k, v] of sp) params[k] = v;
      if (Object.keys(params).length === 0) throw new Error("empty");
    } catch {
      try { params = JSON.parse(rawBody); } catch {}
    }
    const grantType = params["grant_type"];
    const deviceCode = params["device_code"];
    const code = params["code"];
    const clientId = params["client_id"] || "";
    const clientSecret = params["client_secret"] || "";
    console.log(`\n[FAKE GHE] Token exchange: grant_type=${grantType} client_id=${clientId.slice(0,12)}... code=${code ? code.slice(0, 20) + "..." : "none"}`);
    if (deviceCode) {
      const device = activeDevices.get(deviceCode);
      if (!device) return { handled: true, response: jsonResponse({ error: "invalid_grant", error_description: "Device code not found" }, 401) };
      if (device.status === "pending") return { handled: true, response: jsonResponse({ error: "authorization_pending", error_description: "Device pending authorization" }, 403) };
      if (device.status === "authorized") return { handled: true, response: jsonResponse({
        access_token: FAKE_ACCESS_TOKEN, token_type: FAKE_TOKEN_TYPE, scope: FAKE_SCOPE,
        expires_in: 28800, refresh_token: FAKE_ACCESS_TOKEN + "_refresh", refresh_token_url: "https://github.com/login/oauth/refresh",
      })};
      return { handled: true, response: jsonResponse({ error: "expired_token", error_description: "Device code expired" }, 403) };
    }
    if (code || grantType === "authorization_code") {
      const storedCode = code ? authCodes.get(code) : undefined;
      if (!storedCode) {
        // Auto-accept if code not in map (maybe from different flow)
        console.log(`[FAKE GHE] Auth code not found in map, auto-accepting: ${code}`);
        return { handled: true, response: jsonResponse({
          access_token: FAKE_ACCESS_TOKEN, token_type: FAKE_TOKEN_TYPE, scope: FAKE_SCOPE,
          expires_in: 28800, refresh_token: FAKE_ACCESS_TOKEN + "_refresh", refresh_token_url: "https://github.com/login/oauth/refresh",
        })};
      }
      authCodes.delete(code!);
      return { handled: true, response: jsonResponse({
        access_token: FAKE_ACCESS_TOKEN, token_type: FAKE_TOKEN_TYPE, scope: storedCode.scope || FAKE_SCOPE,
        expires_in: 28800, refresh_token: FAKE_ACCESS_TOKEN + "_refresh", refresh_token_url: "https://github.com/login/oauth/refresh",
      })};
    }
    return { handled: true, response: jsonResponse({ error: "invalid_request", error_description: "Missing grant_type or device_code" }, 400) };
  }

  // GET /login - Login page (redirect to account picker or device flow)
  if (method === "GET" && (url === "/login" || url.startsWith("/login?"))) {
    console.log("\n[FAKE DEVICE LOGIN] Login page request, redirecting to account picker...");
    return { handled: true, response: { statusCode: 302, headers: { location: "/login/device/select_account", "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/device - Redirect to account picker or show verification page
  if (method === "GET" && (url === "/login/device" || url.startsWith("/login/device?"))) {
    if (!url.includes("skip_account_picker=true")) {
      console.log("\n[FAKE DEVICE LOGIN] Redirecting to account picker...");
      return { handled: true, response: { statusCode: 302, headers: { location: "/login/device/select_account", "cache-control": "no-store" }, body: Buffer.alloc(0) } };
    }
    console.log("\n[FAKE DEVICE LOGIN] Showing verification page...");
    let userCode = FAKE_USER_CODE;
    for (const [_, device] of activeDevices) {
      if (device.status === "pending") { userCode = device.userCode; break; }
    }
    return { handled: true, response: htmlResponse(generateVerificationPage(userCode)) };
  }

  // POST /login/device/verify-fake - Internal auto-verify
  if (method === "POST" && url.includes("/login/device/verify-fake")) {
    try {
      const data = JSON.parse(body?.toString() || "{}");
      for (const [deviceCode, device] of activeDevices) {
        if (device.userCode === data.code && device.status === "pending") {
          device.status = "authorized";
          console.log(`[FAKE DEVICE LOGIN] Verification page authorized device: ${deviceCode}`);
          return { handled: true, response: jsonResponse({ ok: true }) };
        }
      }
    } catch {}
    return { handled: true, response: jsonResponse({ ok: false }, 400) };
  }

  // GET /user - GitHub user info
  if (method === "GET" && (url === "/user" || url.startsWith("/user?"))) {
    console.log(`\n[FAKE GHE] Intercepting /user request`);
    return { handled: true, response: jsonResponse({
      login: "fake-copilot-user", id: 99999999, node_id: "MDQ6VXNlcjk5OTk5OTk5",
      avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4", gravatar_id: "",
      url: "https://api.github.com/users/fake-copilot-user", html_url: "https://github.com/fake-copilot-user",
      followers_url: "https://api.github.com/users/fake-copilot-user/followers", type: "User",
      name: "Fake Copilot User", company: "Fake Corp", blog: "", location: "Internet", email: "fake@example.com",
      hireable: false, bio: "Fake user for copilot", twitter_username: null,
      public_repos: 42, public_gists: 10, followers: 100, following: 50,
      created_at: "2020-01-01T00:00:00Z", updated_at: "2026-05-18T00:00:00Z",
      plan: { name: "business", space: 976562499, collaborators: 0, private_repos: 9999 },
    })};
  }

  // GET /user/orgs - User's organizations
  if (method === "GET" && url.includes("/user/orgs")) {
    console.log(`\n[FAKE GHE] Intercepting /user/orgs`);
    return { handled: true, response: jsonResponse([{
      login: "github", id: 1, node_id: "MDEyOk9yZ2FuaXphdGlvbjE=",
      url: "https://api.github.com/orgs/github",
      repos_url: "https://api.github.com/orgs/github/repos",
      events_url: "https://api.github.com/orgs/github/events",
      hooks_url: "https://api.github.com/orgs/github/hooks",
      issues_url: "https://api.github.com/orgs/github/issues",
      members_url: "https://api.github.com/orgs/github/members{/member}",
      public_members_url: "https://api.github.com/orgs/github/public_members{/member}",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      description: "GitHub, the world's largest software development platform",
    }]) };
  }

  // GET /user/emails - Email addresses
  if (method === "GET" && (url === "/user/emails" || url.startsWith("/user/emails?"))) {
    return { handled: true, response: jsonResponse([{ email: "fake@example.com", primary: true, verified: true, visibility: "public" }]) };
  }

  // GET /user/memberships/orgs - Organization memberships
  if (method === "GET" && (url === "/user/memberships/orgs" || url.startsWith("/user/memberships/orgs?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/keys - SSH keys
  if (method === "GET" && (url === "/user/keys" || url.startsWith("/user/keys?"))) {
    return { handled: true, response: jsonResponse([{ id: 1, key: "ssh-rsa AAAAB3NzaC1yc2E...", title: "fake-key", created_at: "2024-01-01T00:00:00Z", read_only: false }]) };
  }

  // GET /user/issues - User's issues across repos
  if (method === "GET" && (url === "/user/issues" || url.startsWith("/user/issues?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/starred - Starred repos
  if (method === "GET" && (url === "/user/starred" || url.startsWith("/user/starred?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/subscriptions - Watched repos
  if (method === "GET" && (url === "/user/subscriptions" || url.startsWith("/user/subscriptions?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/blocks - Blocked users
  if (method === "GET" && (url === "/user/blocks" || url.startsWith("/user/blocks?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/gpg_keys - GPG keys
  if (method === "GET" && (url === "/user/gpg_keys" || url.startsWith("/user/gpg_keys?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /user/repository_invitations - Repo invitations
  if (method === "GET" && url.includes("/user/repository_invitations")) {
    return { handled: true, response: jsonResponse([]) };
  }

  // Catch-all for /user/* endpoints
  if (method === "GET" && url.startsWith("/user/")) {
    console.log(`\n[FAKE GHE] Intercepting ${url}`);
    return { handled: true, response: jsonResponse({}) };
  }

  // POST /user/repos - Create repo (GitHub App needs this)
  if (method === "POST" && url === "/user/repos") {
    console.log(`\n[FAKE GHE] Intercepting create repo`);
    let repoName = "fake-repo";
    try { repoName = JSON.parse(body?.toString() || "{}").name || repoName; } catch {}
    const now = new Date().toISOString();
    return { handled: true, response: jsonResponse({
      id: 99999999, node_id: "R_kgDOAAAAAA", name: repoName, full_name: `fake-copilot-user/${repoName}`,
      private: false, owner: { login: "fake-copilot-user", id: 99999999, type: "User" },
      html_url: `https://github.com/fake-copilot-user/${repoName}`,
      description: "Fake repo created by MITM proxy", fork: false,
      url: `https://api.github.com/repos/fake-copilot-user/${repoName}`,
      created_at: now, updated_at: now, pushed_at: now,
      git_url: `git://github.com/fake-copilot-user/${repoName}.git`,
      ssh_url: `git@github.com:fake-copilot-user/${repoName}.git`,
      clone_url: `https://github.com/fake-copilot-user/${repoName}.git`,
      default_branch: "main", language: null, has_issues: true, has_projects: true,
      has_wiki: true, has_downloads: true, archived: false, disabled: false,
      open_issues_count: 0, forks_count: 0, stargazers_count: 0, watchers_count: 0,
      size: 0, visibility: "public",
    }, 201)};
  }

  // POST /_alive - Keep-alive heartbeat
  if (method === "POST" && url === "/_alive") {
    return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
  }

  // GET /login/device/select_account - Device flow account picker page
  if (method === "GET" && url.includes("/login/device/select_account")) {
    console.log(`\n[FAKE DEVICE] Select account page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Device Login - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>Device Activation</h1>
<p style="color:#8b949e">Select an account to continue</p>
<form method="POST" action="/login/device/select_account">
<input type="hidden" name="account" value="fake-github-user">
<button type="submit" style="background:#238636;color:#fff;border:none;border-radius:6px;padding:12px 24px;font-size:16px;cursor:pointer;margin-top:16px;">
  Fake Github User
</button>
</form></div></body></html>`) };
  }

  // POST /login/device/select_account - Confirm account selection
  if (method === "POST" && url.includes("/login/device/select_account")) {
    console.log(`\n[FAKE DEVICE] Account selected`);
    return { handled: true, response: { statusCode: 302, headers: { location: "/login/device?skip_account_picker=true", "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/device/confirmation - Device confirmation page
  if (method === "GET" && url.includes("/login/device/confirmation")) {
    console.log(`\n[FAKE DEVICE] Confirmation page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Device Confirmation - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>Confirm Device Code</h1>
<p style="color:#8b949e">Enter the code shown on your device</p>
<form method="POST" action="/login/device/confirmation">
<input name="user_code" value="${FAKE_USER_CODE}" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-size:24px;text-align:center;color:#58a6ff;font-family:monospace;width:200px;letter-spacing:4px;">
<button type="submit" style="background:#238636;color:#fff;border:none;border-radius:6px;padding:12px 24px;font-size:16px;cursor:pointer;margin-top:16px;display:block;margin-left:auto;margin-right:auto;">
  Confirm
</button>
</form></div></body></html>`) };
  }

  // POST /login/device/confirmation - Submit device code
  if (method === "POST" && url.includes("/login/device/confirmation")) {
    console.log(`\n[FAKE DEVICE] Code submitted`);
    const formBody = body?.toString() || "";
    const formParams = new URLSearchParams(formBody);
    const userCode = formParams.get("user_code") || "";
    let found = false;
    for (const [deviceCode, device] of activeDevices) {
      if (device.userCode === userCode && device.status === "pending") {
        device.status = "authorized";
        found = true;
        break;
      }
    }
    if (found) {
      return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorize Device - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>Authorize Device</h1>
<p style="color:#8b949e">A device is requesting access to your account</p>
<form method="POST" action="/login/device/authorize">
<button type="submit" style="background:#238636;color:#fff;border:none;border-radius:6px;padding:12px 24px;font-size:16px;cursor:pointer;">Authorize</button>
</form>
<p style="font-size:12px;color:#8b949e;margin-top:16px;">Device code: ${userCode}</p>
</div></body></html>`) };
    }
    return { handled: true, response: { statusCode: 302, headers: { location: "/login/device/failure?reason=not_found", "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/device/authorize - Authorize page (GET)
  if (method === "GET" && url.includes("/login/device/authorize")) {
    console.log(`\n[FAKE DEVICE] Authorize page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorize Device - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>Authorize Device</h1>
<p style="color:#8b949e">A device is requesting access. Authorize to continue.</p>
<form method="POST" action="/login/device/authorize">
<button type="submit" style="background:#238636;color:#fff;border:none;border-radius:6px;padding:12px 24px;font-size:16px;cursor:pointer;">Authorize</button>
</form></div></body></html>`) };
  }

  // POST /login/device/authorize - Confirm device authorization
  if (method === "POST" && url.includes("/login/device/authorize")) {
    console.log(`\n[FAKE DEVICE] Device authorized!`);
    return { handled: true, response: { statusCode: 302, headers: { location: "/login/device/success", "cache-control": "no-store" }, body: Buffer.alloc(0) } };
  }

  // GET /login/device/success - Authorization success
  if (method === "GET" && url.includes("/login/device/success")) {
    console.log(`\n[FAKE DEVICE] Success page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Device Authorized - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>✓ Device Authorized</h1>
<p style="color:#8b949e">You may close this window and return to your device.</p>
</div></body></html>`) };
  }

  // GET /login/device/failure - Authorization failure
  if (method === "GET" && url.includes("/login/device/failure")) {
    console.log(`\n[FAKE DEVICE] Failure page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Device Authorization Failed - GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:40px;max-width:500px;text-align:center;">
<h1>✗ Authorization Failed</h1>
<p style="color:#8b949e">The device code was not found or has expired.</p>
<p style="font-size:12px;color:#8b949e;margin-top:16px;"><a href="/login/device" style="color:#58a6ff;">Try again</a></p>
</div></body></html>`) };
  }

  // POST /github-copilot/chat/token - Web Copilot chat token
  if (method === "POST" && url.includes("/github-copilot/chat/token")) {
    console.log(`\n[FAKE GHE] Copilot chat token`);
    const now = Math.floor(Date.now() / 1000);
    return { handled: true, response: jsonResponse({
      token: `ghu_${forge.util.bytesToHex(forge.random.getBytesSync(16))}`,
      expires_at: now + 1800,
      ttl_seconds: 1800,
      refresh_in: 1500,
      chat_enabled: true,
      entitlements: { copilot_chat: true, copilot_chat_org: false },
      plan: { name: "individual", sku: "free_limited_copilot" },
    })};
  }

  // GET /github-copilot/chat/entitlement - Copilot chat entitlement check
  if (method === "GET" && url.includes("/github-copilot/chat/entitlement")) {
    console.log(`\n[FAKE GHE] Copilot chat entitlement`);
    return { handled: true, response: jsonResponse({
      entitlements: { copilot_chat: true, copilot_chat_org: false },
      plan: { name: "individual", sku: "free_limited_copilot" },
    })};
  }

  // GET /github-copilot/chat - Copilot chat page (no subpath)
  if (method === "GET" && (url === "/github-copilot/chat" || url.startsWith("/github-copilot/chat?"))) {
    console.log(`\n[FAKE GHE] Copilot chat page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>GitHub Copilot Chat</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="text-align:center;"><h1>GitHub Copilot Chat</h1><p style="color:#8b949e">Fake copilot chat page (MITM proxy)</p></div></body></html>`) };
  }

  // GET / - Root page
  if (method === "GET" && url === "/") {
    console.log(`\n[FAKE GHE] Root page`);
    return { handled: true, response: htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>GitHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
<div style="text-align:center;"><h1>GitHub</h1><p style="color:#8b949e">Fake GitHub page (MITM Debug Proxy)</p></div></body></html>`) };
  }

  // GET /_side-panels/user.json - Side panel user data
  if (method === "GET" && url.includes("/_side-panels/user.json")) {
    console.log(`\n[FAKE GHE] Side panel user`);
    return { handled: true, response: jsonResponse({
      login: "fake-copilot-user", id: 99999999, avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4",
      name: "Fake Copilot User", copilot_enabled: true,
    })};
  }

  // GET /notifications/indicator - Notification badge
  if (method === "GET" && url.includes("/notifications/indicator")) {
    return { handled: true, response: jsonResponse({ count: 0 }) };
  }

  // GET /favicon.ico - Favicon (empty response)
  if (method === "GET" && url === "/favicon.ico") {
    return { handled: true, response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
  }

  // OPTIONS /copilot_internal/* - CORS preflight
  if (method === "OPTIONS" && url.includes("/copilot_internal/")) {
    return { handled: true, response: { statusCode: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, Accept, User-Agent, X-GitHub-Api-Version, Copilot-Integration-Id", "access-control-max-age": "86400" }, body: Buffer.alloc(0) } };
  }

  // GET /copilot_internal/user - Copilot user info (enterprise plan for model selector)
  if (method === "GET" && url.includes("/copilot_internal/user")) {
    console.log(`\n[FAKE COPILOT] Intercepting copilot user request (enterprise)`);
    const tid = generateTrackingId();
    const q = getRemainingQuota();
    return { handled: true, response: jsonResponse({
      login: "fake-github-user",
      access_type_sku: "enterprise",
      analytics_tracking_id: tid,
      assigned_date: new Date(Date.now() - 86400000 * 11).toISOString(),
      can_signup_for_limited: false,
      chat_enabled: true,
      cli_enabled: true,
      copilotignore_enabled: true,
      copilot_plan: "enterprise",
      editor_preview_features_enabled: true,
      is_mcp_enabled: true,
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
      can_upgrade_plan: false,
      limited_user_quotas: { chat: q.chat, completions: q.completions },
      limited_user_subscribed_day: 7,
      limited_user_reset_date: "2120-01-01",
      monthly_quotas: { chat: 500, completions: 4000 },
    })};
  }

  function buildTokenResponse() {
    const now = Math.floor(Date.now() / 1000);
    const tid = generateTrackingId();
    const exp = now + 1800;
    const iat = now;
    const reset = Math.floor(new Date("2500-01-01T00:00:00Z").getTime() / 1000);
    const q = getRemainingQuota();
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
      copilotignore_enabled: true,
      endpoints: {
        api: "https://api.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
      },
      expires_at: exp,
      iat,
      individual: false,
      limited_user_quotas: { chat: q.chat, completions: q.completions },
      limited_user_reset_date: reset,
      public_suggestions: "disabled",
      refresh_in: 1500,
      sku: "enterprise",
      telemetry: "disabled",
      ip: "91.200.103.13",
      asn: "AS213250",
      token: `tid=${tid};exp=${exp};iat=${iat};sku=enterprise;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;malfil=1;editor_preview_features=1;agent_mode=1;agent_mode_auto_approval=1;mcp=1;blackbird_external_indexing=1;client_byok=1;rt=1;cq=3934;ip=91.200.103.13;asn=AS213250;rd=${reset}`,
      tracking_id: tid,
      xcode: true,
      xcode_chat: false,
    };
  }

  // GET /copilot_internal/v2/token - Copilot token
  if (method === "GET" && url.startsWith("/copilot_internal/v2/token") && !url.startsWith("/copilot_internal/v2/token?")) {
    console.log(`\n[FAKE COPILOT] Intercepting copilot token request: ${url}`);
    return { handled: true, response: jsonResponse(buildTokenResponse()) };
  }

  // GET /copilot_internal/v2/token? - Copilot token with query params
  if (method === "GET" && url.startsWith("/copilot_internal/v2/token?")) {
    console.log(`\n[FAKE COPILOT] Intercepting copilot token (with qs): ${url}`);
    return { handled: true, response: jsonResponse(buildTokenResponse()) };
  }

  // GET /copilot_internal/content_exclusion - VS content exclusion settings
  if (method === "GET" && url.includes("/copilot_internal/content_exclusion")) {
    console.log(`\n[FAKE COPILOT] Intercepting content exclusion: ${url}`);
    return { handled: true, response: jsonResponse({ exclusions: [], scope: "all", enabled: false }) };
  }

  // GET /copilot_internal/repository_search - Copilot repo search
  if (method === "GET" && url.includes("/copilot_internal/repository_search")) {
    console.log(`\n[FAKE COPILOT] Intercepting repository search: ${url}`);
    return { handled: true, response: jsonResponse({
      repositories: [
        { id: 1, name: "fake-repo", name_with_owner: "fake-copilot-user/fake-repo",
          owner_login: "fake-copilot-user", owner_type: "User",
          owner_avatar_url: "https://avatars.githubusercontent.com/u/99999999?v=4",
          is_private: false, visibility: "public",
          html_url: "https://github.com/fake-copilot-user/fake-repo", description: "Fake repo for Copilot testing",
          language: "TypeScript", default_branch: "main",
        },
      ],
      total_count: 1, incomplete_results: false,
    })};
  }

  // GET /app - GitHub App info
  if (method === "GET" && (url === "/app" || url.startsWith("/app?"))) {
    return { handled: true, response: jsonResponse({
      id: 999999, slug: "fake-app", node_id: "MDM6QXBwOTk5OTk5",
      owner: { login: "fake-copilot-user", id: 99999999, type: "User" },
      name: "Fake GitHub App", description: "Fake app for MITM proxy",
      external_url: "https://example.com", html_url: "https://github.com/apps/fake-app",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2026-05-18T00:00:00Z",
      permissions: { contents: "write", issues: "write", metadata: "read" },
      events: ["push", "issues"], installations_count: 1,
    })};
  }

  // GET /app/installations - App installations
  if (method === "GET" && (url === "/app/installations" || url.startsWith("/app/installations?"))) {
    return { handled: true, response: jsonResponse([{
      id: 1, app_id: 999999, app_slug: "fake-app",
      target_id: 99999999, target_type: "User",
      target_login: "fake-copilot-user",
      repository_selection: "all", access_tokens_url: "https://api.github.com/app/installations/1/access_tokens",
      repositories_url: "https://api.github.com/installation/repositories",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2026-05-18T00:00:00Z",
    }])};
  }

  // POST /app/installations/*/access_tokens - Installation access tokens
  if (method === "POST" && url.includes("/app/installations/") && url.includes("/access_tokens")) {
    const now = Math.floor(Date.now() / 1000);
    return { handled: true, response: jsonResponse({
      token: FAKE_ACCESS_TOKEN + "_inst", expires_at: new Date((now + 3600) * 1000).toISOString(),
      repositories: [], repository_selection: "all", permissions: { contents: "write", metadata: "read", issues: "write" },
    })};
  }

  // GET /installation/repositories - Installation repos
  if (method === "GET" && (url === "/installation/repositories" || url.startsWith("/installation/repositories?"))) {
    return { handled: true, response: jsonResponse({
      total_count: 1, repository_selection: "all", repositories: [{
        id: 1, name: "fake-repo", full_name: "fake-copilot-user/fake-repo", private: false,
        owner: { login: "fake-copilot-user", id: 99999999, type: "User" },
        html_url: "https://github.com/fake-copilot-user/fake-repo",
        description: "Fake repo", fork: false, language: "TypeScript",
        default_branch: "main", permissions: { admin: true, push: true, pull: true },
      }],
    })};
  }

  // GET /meta - GitHub API meta info
  if (method === "GET" && (url === "/meta" || url.startsWith("/meta?"))) {
    return { handled: true, response: jsonResponse({
      verifiable_password_authentication: false,
      ssh_key_fingerprints: { SHA256_RSA: "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8" },
      hooks: ["127.0.0.1"], web: ["127.0.0.1"], api: ["127.0.0.1"], git: ["127.0.0.1"],
      packages: ["127.0.0.1"], pages: ["127.0.0.1"], importer: ["127.0.0.1"],
    })};
  }

  // GET /orgs/* - Get organization
  if (method === "GET" && url.match(/^\/orgs\/[^/]+(\?|$)/)) {
    return { handled: true, response: jsonResponse({
      login: "fake-org", id: 999999999, node_id: "O_kgDOD6KtmA",
      url: "https://api.github.com/orgs/fake-org",
      repos_url: "https://api.github.com/orgs/fake-org/repos",
      description: null, name: "Fake Org", company: null, blog: null, location: null,
      email: null, twitter_username: null, is_verified: false,
      has_organization_projects: true, has_repository_projects: true,
      public_repos: 1, public_gists: 0, followers: 0, following: 0,
      created_at: "2020-01-01T00:00:00Z", updated_at: "2026-05-18T00:00:00Z",
      plan: { name: "business", space: 976562499, private_repos: 9999, filled_seats: 0, seats: 0 },
    })};
  }

  // GET /gists or /gists/* - Gists
  if (method === "GET" && (url === "/gists" || url.startsWith("/gists?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /notifications - Notifications
  if (method === "GET" && (url === "/notifications" || url.startsWith("/notifications?"))) {
    return { handled: true, response: jsonResponse([]) };
  }

  // GET /search/* - Search endpoints
  if (method === "GET" && url.startsWith("/search/")) {
    return { handled: true, response: jsonResponse({
      total_count: 0, incomplete_results: false, items: [],
    })};
  }

  // GET /settings/* - Settings pages (redirect to root in hybrid, fake in mock)
  if (method === "GET" && url.startsWith("/settings/")) {
    if (isHybridMode) return { handled: false };
    return { handled: true, response: htmlResponse(`<!DOCTYPE html><html><head><title>GitHub Settings</title></head>
<body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px;">
<h1>Settings</h1><p style="color:#8b949e">Fake settings page (MITM proxy)</p></body></html>`) };
  }

  return { handled: false };
}
