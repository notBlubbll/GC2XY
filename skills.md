## Copilot Plans, SKUs & Quota

### Plan/SKU Reference Table

| `copilot_plan` | `access_type_sku` | Display | Quota Field | `individual` (token) |
|----------------|-------------------|---------|-------------|---------------------|
| `individual` | `free_limited_copilot` | Copilot Free | `limited_user_quotas` | `true` |
| `individual` | `copilot_for_individual` | Copilot Pro | `limited_user_quotas` | `true` |
| `business` | `copilot_for_business_seat` | Copilot Business | `quota_snapshots` | `false` |
| `enterprise` | `copilot_enterprise_seat` | Copilot Enterprise | `quota_snapshots` | `false` |

### Field Behavior

- **`access_type_sku`** — determines the plan label displayed in VS UI (e.g. "Copilot Free", "Copilot Enterprise")
- **`individual: true`** (token only) — required for VS to show the usage/quota section. Without it, VS shows "unable to retrieve"
- VS ignores `percent_remaining` — always computes `used = (entitlement - remaining) / entitlement`
- `limited_user_quotas` values represent **remaining**, not used

### Individual/Free Format (`limited_user_quotas`)

```json
{
  "copilot_plan": "individual",
  "access_type_sku": "free_limited_copilot",
  "limited_user_quotas": { "chat": 290, "completions": 2320 },
  "monthly_quotas": { "chat": 500, "completions": 4000 },
  "limited_user_reset_date": "2026-06-07"
}
```

Token response also includes: `"individual": true`, `"sku": "free_limited_copilot"`

### Business/Enterprise Format (`quota_snapshots`)

```json
{
  "copilot_plan": "enterprise",
  "access_type_sku": "copilot_enterprise_seat",
  "quota_reset_date": "2120-01-01T00:00:00Z",
  "quota_snapshots": {
    "chat": { "entitlement": 0, "remaining": 0, "percent_remaining": 0, "unlimited": true, "overage_permitted": false, "overage_count": 0 },
    "completions": { "entitlement": 0, "remaining": 0, "percent_remaining": 0, "unlimited": true, "overage_permitted": false, "overage_count": 0 },
    "premium_interactions": { "entitlement": 1000, "remaining": 580, "percent_remaining": 58, "unlimited": false, "overage_permitted": true, "overage_count": 0 }
  }
}
```

Token response for enterprise: `"sku": "enterprise"`, `"limited_user_quotas": { "chat": 290, "completions": 2320 }`, `"quota_reset_date": ...`

### VS Handler Configuration

The VS handler (`vs/auth.ts`) uses `handleVSAuth` (runs first in chain, before `handleAuth`). Detection is via `editor-version` header matching `VS/VisualStudio*` or `/^VS\/\d/`.

Recommended VS config:
- `copilot_plan: "max"` (display label)
- `access_type_sku: "free_limited_copilot"` (feature gating, makes usage work)
- Token: `sku: "free_limited_copilot"`, `individual: true`

### Files to Edit

| File | Purpose |
|------|---------|
| `vs/auth.ts:56-84` | VS copilot user response (`handleVSCopilotUser`) |
| `vs/auth.ts:89-127` | VS token response (`handleVSToken`) |
| `auth-handler.ts:588-613` | Non-VS copilot user response (GHCP app/CLI) |
| `auth-handler.ts:618-656` | Non-VS token response |

## VS Model List — Real GitHub Billing & Pricing (Passthrough Capture)

### Key Differences from Our Fake Format

Real GitHub API model list for VS uses a different billing structure than our fake responses:

### `token_prices` Billing (Real GitHub)

Premium models (e.g. `claude-opus-4.7`, `claude-opus-4.8`) use `token_prices` instead of `multiplier`:

```json
{
  "billing": {
    "token_prices": {
      "batch_size": 1000000,
      "cache_price": 50000000000,
      "input_price": 500000000000,
      "output_price": 2500000000000
    }
  }
}
```

- **`is_premium`** is NOT present in real billing objects
- Free models use `token_prices` with all zero prices
- `multiplier` is our fabricated field — real GitHub doesn't use it

### `model_picker_category`

Categorizes models into sections in the VS picker dropdown:

| Value | Used For |
|-------|----------|
| `"powerful"` | Premium models (opus, pro, codex, deepseek-flash, omni) |
| `"versatile"` | Default/mid-tier models (sonnet, standard models) |
| `"lightweight"` | Small/fast/free models (mini, nano, haiku, flash, free tiers) |

### `model_picker_price_category`

A separate top-level field on the model object (NOT inside billing), indicates cost tier. The authoritative enum is `ModelPickerPriceCategory` in `github/copilot-sdk` (`rust/src/generated/api_types.rs`), auto-generated from `api.schema.json`:

| Value | Used For |
|-------|----------|
| `"very_high"` | Highest relative token cost tier (most expensive models) |
| `"high"` | Premium/expensive models (opus, pro, codex) |
| `"medium"` | Mid-tier (sonnet, standard) |
| `"low"` | Free/cheap models (haiku, free_limited_copilot) |

- This field is independent of `model_picker_category`
- The enum also has an `Unknown` variant (`#[serde(other)]`, default) for forward compatibility — any unrecognized string deserializes to it, so clients tolerate new tiers without breaking
- In `microsoft/vscode` the type is a plain `string?` (`src/typings/copilot-api.d.ts:156`), so the Rust SDK is the only place the closed set is enforced
- Provider separator entries use `"very_high"` to visually separate groups at the top (the strongest visual separator)

### `policy.state` for Premium Models

Real GitHub sets `policy.state: "disabled"` for premium models not available on the current plan:

```json
{
  "policy": {
    "state": "disabled",
    "terms": "Enable access to the claude-opus-4.7 model. [Learn more](https://opencode.ai)"
  }
}
```

### VS User Plan (Real Capture)

Even when VS is detected, the real user response returns `free_limited_copilot` plan:

- `token_based_billing: true` in copilot user response
- `copilot_plan: "individual"`, `access_type_sku: "free_limited_copilot"`
- This means the model picker shows premium models as disabled (greyed out) unless the user upgrades

### Separator Entries

Fake separator entries inserted between provider groups in the VS model list use:
- `model_picker_price_category: "high"` → visually separates groups in the picker
- `policy.state: "disabled"` → renders as a non-selectable label
- `name` set to the full provider name: "OpenCode Go", "Pollinations.ai", "FreeBuff", "AgnesAI"
- `model_picker_enabled: false` → not selectable

## VS22 (Legacy 17.x) Auth Emulator — Current State

Documents the full VS 2022 (17.x) auth flow as emulated by `handleVSLegacy` (`src/handlers/vs-legacy/index.ts`). This handler runs **first** in the interceptor chain (before `handleVSShell` and `handleAuth`) for any request where `isVSLegacy(headers)` returns true (editor-version `VS/17.x` or user-agent `VSTeamExplorer`) or `isVSOAuthBrowser(req)` returns true (URL contains `client_id=a200baed193bb2088a6e`).

### OAuth Flow (Legacy localhost Redirect)

VS 2022 uses the browser-based OAuth flow with `http://localhost:PORT/` as the redirect_uri (NOT the newer `vsweb+githubsi://` scheme). The full flow as emulated:

```
1. Browser → GET /login/oauth/authorize?prompt=select_account&client_id=a200baed193bb2088a6e&redirect_uri=http://localhost:PORT/&scope=...&state=unused
   Handler: prompt=select_account → 302 → /login/oauth/select_account?...&prompt=select_account

2. Browser → GET /login/oauth/select_account?client_id=...&prompt=select_account&redirect_uri=...&scope=...&state=unused
   Handler: Returns HTML account picker. Form action = POST to /login/oauth/authorize_app?...&skip_account_picker=true
   Auto-submit JS: setTimeout(form.submit(), 1500) — hands-free

3. Browser → POST /login/oauth/authorize_app?client_id=...&redirect_uri=...&scope=...&skip_account_picker=true&state=unused
   Handler: 302 → /login/oauth/authorize?...&skip_account_picker=true (preserves skip_account_picker)

4. Browser → GET /login/oauth/authorize?client_id=...&redirect_uri=...&scope=...&skip_account_picker=true&state=unused
   Handler: skip_account_picker=true → skip select_account redirect, generate auth code
   Returns HTML with <meta http-equiv="refresh" content="0;url=http://localhost:PORT/?code=...&state=unused">

5. Browser → http://localhost:PORT/?code=...&state=unused → VS local server receives code

6. VS (Octokit.net) → POST /login/oauth/access_token
   Body: client_id=...&code=...&redirect_uri=http://localhost:PORT/&grant_type=authorization_code
   Handler: Returns { access_token: "gho_...", token_type: "bearer", scope: "user,repo,gist,write:public_key,read:org,workflow", expires_in: 28800, refresh_token: "...", refresh_token_expires_in: 15897600 }

7. VS → GET /user, GET /, GET /user/orgs (api.github.com)
8. VS → GET /copilot_internal/v2/token, GET /copilot_internal/user (api.github.com)
9. VS → GET /models (api.individual.githubcopilot.com)
10. VS opens https://visualstudio.microsoft.com/de/vs/github-signed-in/ in browser (not intercepted)
```

**Key**: `skip_account_picker=true` must be preserved through the redirect chain (authorize_app → authorize). The authorize handler checks `skip_account_picker` — if true, it generates the auth code directly instead of redirecting back to select_account.

### Critical Response Headers (`ghApiJsonResponse`)

VS/Octokit.net checks `x-oauth-scopes` on every `api.github.com` response to verify the token is valid. Without it, VS reports `NotSignedInToGitHub` and stops before reaching `/copilot_internal/v2/token`. The `ghApiJsonResponse()` helper in `shared.ts` adds:

```
x-oauth-scopes: gist, read:org, repo, user, workflow, write:public_key
x-oauth-client-id: a200baed193bb2088a6e
x-accepted-oauth-scopes: (varies by endpoint)
x-github-media-type: github.v3; format=json
x-github-api-version-selected: 2022-11-28
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4999
x-ratelimit-reset: <now + 3600>
x-github-request-id: MITM:<hex>
server: github.com
```

**Use `ghApiJsonResponse()`** for ALL `api.github.com` JSON responses (`/user`, `/`, `/user/orgs`, `/copilot_internal/user`, `/copilot_internal/v2/token`). Use `jsonResponse()` for `api.individual.githubcopilot.com` responses (different header set — no x-oauth-scopes).

### `/copilot_internal/v2/token` Response (Token)

```json
{
  "sku": "enterprise",
  "individual": true,
  "limited_user_quotas": { "chat": 210, "completions": 1680 },
  "limited_user_reset_date": 1785542400,
  "expires_at": <now + 1800>,
  "refresh_in": 1500,
  "endpoints": { "api": "https://api.individual.githubcopilot.com", ... },
  "token": "tid=...;exp=...;iat=...;sku=enterprise;...;rd=<1st_of_next_month>",
  ...
}
```

- `individual: true` — REQUIRED for VS to show the usage/quota section. Without it: "unable to retrieve"
- `limited_user_reset_date` — Unix timestamp for 1st of next month (calculated via `setUTCMonth`)
- `sku: "enterprise"` — default SKU (configurable via `getGithubSku()` in config.json)

### `/copilot_internal/user` Response (User)

```json
{
  "login": "<username>",
  "access_type_sku": "copilot_enterprise_seat",
  "copilot_plan": "enterprise",
  "is_staff": false,
  "quota_snapshots": {
    "chat": { "overage_count": 0, "overage_permitted": false, "percent_remaining": 42, "quota_id": "chat", "quota_remaining": 210, "unlimited": true, "timestamp_utc": "...", "has_unlimited_access": true },
    "completions": { ... same structure ... },
    "premium_interactions": { "percent_remaining": 58, "quota_remaining": 580, "unlimited": false, ... }
  }
}
```

- Does NOT include `limited_user_quotas`, `monthly_quotas`, or `limited_user_reset_date` — those are ONLY in the token response
- `quota_snapshots` is REQUIRED — `CopilotModelResolver.SelectModelAsync` takes quotas from here. Without it: "No model found that matches the request"
- `is_staff: false` — must be present (real GitHub includes it)

### NaN% Usage Display (Feature)

When `copilot_plan: "enterprise"` with `quota_snapshots.chat.unlimited: true` but NO `monthly_quotas` in the user response, VS displays "NaN%" for usage. This is **intentional and useful**:

- Indicates the quota is unlimited/untracked (enterprise plan)
- Visually distinguishes the proxy from real GitHub (which would show actual usage)
- No fix needed — keep as-is

### `/models` Response (Model List)

The `/models` handler in `handleVSLegacy` has a **3-tier fallback**:

1. Try `handleVSModels(req)` — delegates to `vs/models.ts` which calls `ensureModels()` → `addModels()`
2. If that fails/throws, try `ensureVSModels()` directly
3. If `VS_MODELS` is still empty, return a minimal inline fallback model:

```json
{
  "id": "agnes-2.0-flash",
  "is_chat_default": true,
  "is_chat_fallback": true,
  "billing": { "is_premium": false, "restricted_to": [] },
  "policy": { "state": "enabled" }
}
```

**`addModels()`** uses `Promise.allSettled` (not `Promise.all`) — if one provider init throws (e.g., Freebuff with 0 tokens), other providers still return their models.

**Model `restricted_to`**: models with `restricted_to: ["pro", "pro_plus", "business", "enterprise", "max"]` are accessible to enterprise users. The fallback model uses `restricted_to: []` (no restrictions).

### Handler Chain (device-login-emulator.ts)

```
1. handleSSMSUsage          — SSMS usage endpoints
2. handleVSLegacy           — VS 2022 (17.x): auth, models, chat, embeddings (RUNS FIRST for VS22)
3. handleVSShell             — VS 2026+ and SSMS: auth (enterprise plan)
4. handleAuth                — GitHub auth, user, orgs, copilot token/user (non-VS)
5. handleRepo                — Repository operations
6. handleGHCPApp             — GitHub App (Windows)
7. handleSSMSChat            — SSMS chat
8. handleVisualStudio        — VS 2026+ chat/models
9. handleCopilot             — Copilot API (non-VS clients)
```

`handleVSLegacy` enters when `isVSLegacy(headers)` is true (editor-version `VS/17.x` or UA `VSTeamExplorer`). For OAuth browser requests, `isVSOAuthBrowser(req)` checks URL for `client_id=a200baed193bb2088a6e`.

### Hybrid Mode Interception

In hybrid mode, browser GET requests with `Accept: text/html` are passed through to real GitHub — EXCEPT when `isVsOAuth` is true (URL contains `client_id=a200baed193bb2088a6e` for VS, or `client_id=01ab8ac9400c4e429b23` / `get_started_with=copilot-vscode` / `redirect_uri=...vscode.dev/redirect` for VS Code). This ensures the VS and VS Code OAuth flows are always intercepted, even in hybrid mode.

```typescript
if (isHybridMode && isBrowser && method === "GET" && !isVsOAuth) {
  return { handled: false }; // passthrough to real GitHub
}
```

### Files to Edit

| File | Purpose |
|------|---------|
| `src/handlers/vs-legacy/index.ts:112` | `handleVSLegacy` entry point |
| `src/handlers/vs-legacy/index.ts:141` | `/copilot_internal/user` response |
| `src/handlers/vs-legacy/index.ts:208` | `/copilot_internal/v2/token` response |
| `src/handlers/vs-legacy/index.ts:249` | `/models` handler (with fallback) |
| `src/handlers/vs-legacy/index.ts:262` | `/models/session` response |
| `src/handlers/vs-legacy/index.ts:278` | `/embeddings` response |
| `src/handlers/auth-handler.ts:162` | `POST /login/oauth/authorize_app` |
| `src/handlers/auth-handler.ts:191` | `GET /login/oauth/select_account` (HTML + auto-submit) |
| `src/handlers/auth-handler.ts:246` | `POST /login/oauth/select_account` |
| `src/handlers/auth-handler.ts:269` | `GET /login/oauth/authorize` (skip_account_picker check) |
| `src/handlers/auth-handler.ts:307` | `POST /login/oauth/access_token` (token exchange) |
| `src/handlers/auth-handler.ts:396` | `GET /user` (uses ghApiJsonResponse) |
| `src/handlers/auth-handler.ts:425` | `GET /user/orgs` (uses ghApiJsonResponse) |
| `src/handlers/auth-handler.ts:97` | `GET /` api root (uses ghApiJsonResponse) |
| `src/shared.ts:329` | `ghApiJsonResponse()` helper (OAuth headers) |
| `src/models.ts:15` | `addModels()` — Promise.allSettled (resilient) |
| `src/handlers/vs/models.ts:148` | `ensureModels()` — try/catch + fallback |
| `src/handlers/vs/models.ts:314` | `handleVSModels()` — model list endpoint |
