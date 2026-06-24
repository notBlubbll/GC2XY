# gc2xy - MITM Debug Proxy with Copilot Auth Bypass

## Overview

A system-wide HTTPS interception proxy for `github.com` (and subdomains) that:
- Decrypts and logs ALL HTTPS traffic in plain English
- Fakes GitHub API responses to bypass Copilot authentication
- Supports record/replay of HTTP flows
- Auto-caches upstream responses for offline mock replay
- Can be extended with custom request/response interceptors
- **Web dashboard** at `http://github.com/dashboard` — status header, provider/model toggles, free models

## ⚡ Key Finding: Real Copilot Endpoints (from proxy capture)

Modern Copilot Chat (VS Code 2024+, Visual Studio 2026) uses `*.individual.githubcopilot.com` subdomains returned in the token response, NOT `api.githubcopilot.com` directly:

| Subdomain | Purpose |
|-----------|---------|
| `api.individual.githubcopilot.com` | Chat API (agents/sessions, messages, MCP, models) |
| `origin-tracker.individual.githubcopilot.com` | Origin tracking |
| `proxy.individual.githubcopilot.com` | Proxy operations |
| `telemetry.individual.githubcopilot.com` | Telemetry |

Real token format (from `copilot_internal/v2/token`):
```
tid=...;exp=1779131468;iat=1779129668;sku=free_limited_copilot;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom;chat=1;cit=1;...
```

Real copilot user response includes `endpoints` object — our fake responses MUST include it so VS Code/VS directs all Copilot API traffic through our intercept proxy.

## How It Works

1. **Hosts file redirect**: All `INTERCEPTED_HOSTS` (github.com + copilot subdomains) → `127.0.0.1`
2. **TLS server on port 443**: Intercepts HTTPS with a dynamically-generated certificate signed by a local CA
3. **HTTP server on port 80**: Intercepts plain HTTP
4. **Interceptors**: Request/response hooks that can modify or short-circuit traffic
5. **Cache-first**: In mock mode, checks `cache/` before falling through to fake handlers
6. **Real IP bypass**: Uses hardcoded real GitHub IPs for traffic forwarded upstream in proxy mode
7. **Host header routing (PROXY mode)**: The unified intercept cert covers every intercepted host with a single SAN, so SNI is not reliable for upstream routing. `forwardWithInterceptor` (`mitm-proxy.ts:634-639`) prefers the HTTP `Host:` header (what the client actually requested) over SNI when building the upstream target. This is what makes `api.github.com/user/orgs` route to real `api.github.com` instead of `github.com:443` (which has no API and returns 404).
8. **Tool salvager** (`src/tool-salvager.ts`): per-tool schema coercion + JSON salvage + apology/loop detection. Upstream LLMs (Agnes, Pollinations, Freebuff, etc.) frequently emit broken or non-VS tool calls — the salvager repairs them or replaces the entire response with `task_complete` so VS stops waiting on a stuck model. See **Tool Salvager** section below.

## IIS Reverse Proxy Mode (Alternative)

Instead of hosts file + raw TLS, gc2xy can run behind IIS:
- **Auto-detected**: If W3SVC (World Wide Web Publishing Service) is running, all launcher scripts automatically set `IIS_PROXY=1` and `gc2xy_HTTP_PORT=3080`
- Manual: Set `IIS_PROXY=1` — only the HTTP server runs (IIS handles TLS termination)
- `web.config` provides URL Rewrite rules forwarding all intercepted hosts to `http://127.0.0.1:3080`
- Defaults to port `3080` via `gc2xy_HTTP_PORT` env var (downstream code default is `3080`, not `8080`)
- Status bar shows `Port: 443 → 3080` when IIS mode is active
- HTTP handler detects `x-forwarded-proto: https` from IIS to upstream correctly as HTTPS

### IIS Architecture

```
Browser → https://github.com/ → IIS (port 443, TLS termination)
  → ARR URL Rewrite → http://127.0.0.1:3080/
  → gc2xy proxy (HTTP server) → fake handler / upstream
  → Response back through IIS → Browser
```

**Key constraint**: The browser must resolve `github.com` → `127.0.0.1` to reach IIS. This requires:
1. **Hosts file redirect** — `127.0.0.1 github.com ...` in `C:\Windows\System32\drivers\etc\hosts`
2. **Chrome DNS-over-HTTPS disabled** — Chrome's Secure DNS (DoH) bypasses the OS hosts file by resolving via Cloudflare/Google DoH servers directly. Without disabling it, Chrome connects to real GitHub IPs (140.82.x.x) and never reaches IIS.

### IIS Site Setup (`!ACTIVATE.cmd`)

`!ACTIVATE.cmd` performs these IIS-specific steps when W3SVC is detected:

1. **Clean up stale SSL bindings** — removes leftover `ipport=0.0.0.0:443` and `[::]:443` global bindings from previous runs (these poison other IIS sites on port 443), plus SNI `hostnameport=` bindings for our intercepted hosts
2. **Create/update IIS site** — `gc2xy` site (id:6) with SNI bindings (`sslFlags='1'`) for all intercepted hostnames on ports 80 and 443, using `.iis-site/` as physical path
3. **Write `web.config`** — ensures `.iis-site/web.config` exists with the ARR reverse proxy rewrite rule
4. **Import SSL certificate** — `certutil -importpfx MY .certs\intercept.pfx` (legacy CSP-backed, compatible with `netsh http`). Reads the actual thumbprint from the Windows cert store after import (forge-computed thumbprint may differ)
5. **Register SNI SSL bindings** — `netsh http add sslcert hostnameport=<host>:443 certhash=<thumbprint>` for each intercepted host. Uses SNI only — never `ipport=0.0.0.0:443` which would poison other IIS sites
6. **Preserve other IIS sites** — `iis-preserve-sites.ps1` discovers non-gc2xy sites with HTTPS:443 bindings and registers their SSL certs as SNI bindings in http.sys. Required because removing the global `0.0.0.0:443` binding breaks non-SNI sites (like the `secure` site at `dexx-dev04.toshibatec-tgis.com`)
7. **Enable ARR reverse proxy** — `appcmd set config -section:system.webServer/proxy /enabled:True`
8. **`iisreset` + start site** — restarts IIS, then starts the `gc2xy` app pool and site with retry logic (up to 5 retries, 1s between each, waiting for `state:Started`)
9. **Patch hosts file** — appends `127.0.0.1 github.com www.github.com ...` if not already present, then `ipconfig /flushdns`
10. **Disable Chrome DoH** — sets `HKLM\SOFTWARE\Policies\Google\Chrome\DnsOverHttpsMode=off` to prevent Chrome from bypassing the hosts file via DNS-over-HTTPS

### IIS Site Cleanup (`!REMOVE.cmd`)

1. Remove all `gc2xy` site bindings (`/-bindings`)
2. Stop site and app pool
3. Delete global `ipport=0.0.0.0:443` and `[::]:443` SSL bindings (leftover from old runs)
4. Delete SNI `hostnameport=` bindings for all intercepted hosts
5. Clean hosts file — remove `127.0.0.1 github.com ...` entries
6. `iisreset`
7. Restore other IIS sites' SSL bindings via `iis-preserve-sites.ps1`
8. Remove Chrome DoH policy

### Chrome DNS-over-HTTPS (Critical)

Chrome's Secure DNS feature resolves hostnames via encrypted DNS (DoH) servers (Cloudflare, Google) instead of the OS resolver. This **completely bypasses** the `hosts` file redirect, so Chrome connects to real GitHub IPs and never reaches IIS.

**Symptom**: `ping github.com` resolves to `127.0.0.1` (hosts file works), but `https://github.com/` in Chrome shows the real GitHub site (DoH bypasses hosts).

**Fix**: `!ACTIVATE.cmd` sets `HKLM\SOFTWARE\Policies\Google\Chrome\DnsOverHttpsMode=off` via registry. This forces Chrome to use the OS DNS resolver which respects the hosts file. **Users must close ALL Chrome windows and reopen** for the policy to take effect.

`!REMOVE.cmd` does NOT currently restore the DoH policy — it leaves it disabled. This is intentional since most corporate environments prefer OS DNS anyway.

### IIS SNI vs Non-SNI Bindings

| Binding Type | Format | Behavior | gc2xy Usage |
|-------------|--------|----------|-------------|
| **SNI** | `hostnameport=<host>:443` with `sslFlags='1'` | Matches only the specified hostname via TLS SNI extension | All gc2xy intercepted hosts |
| **Non-SNI (global)** | `ipport=0.0.0.0:443` with `sslFlags='0'` | Matches ALL HTTPS on port 443 regardless of hostname | **NEVER used** — poisons other IIS sites |

Other IIS sites with non-SNI HTTPS bindings on port 443 (like the `secure` site at `*:443:dexx-dev04.toshibatec-tgis.com sslFlags=0`) need their SSL certs registered as SNI bindings in http.sys. Without this, removing the global `0.0.0.0:443` binding breaks them. `iis-preserve-sites.ps1` handles this automatically.

### IIS Service Recovery

```batch
sc config w3svc start= auto
sc start w3svc
sc failure w3svc reset= 86400 actions= restart/5000/restart/10000/restart/30000
```

## Key Files

| File | Purpose |
|------|---------|
| `!ACTIVATE.cmd` | **Unified launcher**: DNS flush, CA install, mode selection (mock/hybrid/proxy). IIS detection with site setup, SSL cert binding (SNI only), other-site preservation, hosts file patch, Chrome DoH disable. Bun/Node fallback. Passes `--mode-2`/`--mode-3` launch args |
| `start.cmd` | Shorthand wrapper that calls `!ACTIVATE.cmd` with optional mode arg |
| `start-mock.cmd` | Standalone mock launcher (auto-elevate, IIS detect, Bun/Node fallback) |
| `start-hybrid.cmd` | Standalone hybrid launcher (same features) |
| `start-proxy.cmd` | Standalone proxy launcher (same features) |
| `_start-node.cmd` | Node.js-only fallback launcher (auto-elevate, IIS detect, mode switching via exit codes, no Bun required) |
| `!REMOVE.cmd` | Kill proxy, clean hosts, remove CA cert (IIS-aware port cleanup, restores other sites' SSL bindings) |
| `iis-preserve-sites.ps1` | Discovers non-gc2xy IIS sites with HTTPS:443 bindings and outputs their cert thumbprints + hostnames. Used by `!ACTIVATE.cmd` and `!REMOVE.cmd` to register/restore other sites' SSL certs as SNI bindings in http.sys |
| `mitm-proxy.ts` | Main proxy: TLS/HTTP servers, hosts redirect, interceptor engine, request forwarding, cache integration, **deletes `package-lock.json` on startup** (avoids stale lock) |
| `cache.ts` | Auto-cache: saves upstream responses to `cache/<sanitized-url>.json`; loads before fake handlers in mock mode |
| `split-console.ts` | Console dashboard TUI: status banner with model column (grouped by provider: FREEBUFF / CODESTRAL / OC-GO / OTHER), log buffer, keyboard commands, debug/record/restart toggles, mode switching, terminal resize handling, **Windows Terminal tab color** via `settings.json` hot-reload |
| `handlers/anthropic-bridge.ts` | Anthropic→OpenAI request conversion via `llm-bridge` library (system prompt, tool_use/tool_result, thinking blocks) |
| `handlers/freebuff-client.ts` | Freebuff provider: embedded Codebuff free-tier pipeline. Session management, token pool, run chains, dynamic model registry (fetches from Codebuff GitHub + hardcoded fallback), dynamic User-Agent version detection, chat completion forwarding |
| `handlers/device-login-emulator.ts` | Route dispatcher: vs-auth → auth → repo → ghcp-app → vs → copilot → catch-all (`handleVSAuth` runs first so VS gets enterprise plan) |
| `handlers/auth-handler.ts` | All auth endpoints: device login, OAuth PKCE, user info, copilot user/token, CORS preflight (individual/free responses) |
| `llm-bridge` (npm) | External library for Anthropic↔OpenAI translation (`anthropicToUniversal`, `universalToOpenAI`, streaming parsers/emitters) |
| `handlers/opencode-client.ts` | Core LLM forwarding client: **4-provider model routing** (OC-GO / POLL / FREEBUFF / AGNES), API key balancer, model init, tool normalization, **forwards all request params upstream** (no whitelist) |
| `opencode-workspace.ts` | Workspace usage fetcher: fetches root page `/` and each workspace `/go` page, parses ALL `<script>` blocks for `$R` embedded data (workspace IDs + rolling/weekly/monthly usage). Falls back to `_server` RPC API if root page extraction fails. |
| `handlers/copilot-handler.ts` | All Copilot API routes: sessions, messages, MCP, models, completions, embeddings, tokenize (non-VS/non-GHCP) |
| `handlers/vs/handler.ts` | Visual Studio chat endpoints: `/v1/messages`, `/responses`, `/chat/completions` |
| `handlers/vs/auth.ts` | Visual Studio enterprise auth: copilot user, token, content exclusion |
| `handlers/vs/models.ts` | Visual Studio model list — real GitHub billing format (`token_prices`, `model_picker_price_category`, `policy.state`). Injects fake category separator entries (`cat_*`) between provider groups using model clone approach. Filters by active providers and disabled models from `config.json`. |
| `handlers/ghcp-app/index.ts` | GitHub App (Windows) route dispatcher: detects `github-app/*` User-Agent |
| `handlers/ghcp-app/auth.ts` | GHCP app auth helpers and detection |
| `handlers/ghcp-app/models.ts` | GHCP app model list format |
| `handlers/repo-handler.ts` | Repository operations: issues, comments, reactions, releases, assets, feedback |
| `shared.ts` | Shared types (`HttpResponse`, `HandlerInput`, `HandlerResult`) and helpers |
| `record-replay.ts` | Record/replay console for capturing and replaying HTTP flows (legacy; cache.ts is the modern replacement) |
| `build.cmd` | **Unified build**: auto-detects Bun or Node.js, delegates to `build-bun.cmd` or `build-node.cmd` |
| `build-bun.cmd` | Bun standalone build: compiles TS → single `gc2xy` exe + C# service wrapper |
| `build-node.cmd` | Node.js portable build: copies src/ + node_modules/ + node.exe + C# service wrapper |
| `src/tool-salvager.ts` | **Tool salvager**: per-tool schema coercion + JSON salvage + apology/loop detection. Repairs broken `tool_calls` from upstream LLMs (Agnes, Pollinations, Freebuff) or replaces them with `task_complete` so VS doesn't get stuck. See **Tool Salvager** section below. |
| `bunfig.toml` | Bun runtime config: telemetry off, small heap mode, no install cache |
| `.config/.env` | Environment configuration (API keys) |
| `certs/` | Auto-generated CA key/cert and unified multi-SAN intercept cert |
| `.proxy-logs/` | Daily traffic log files with JSON entries + `bodyPreview` (first 1000 chars) |
| `.cache/` | Auto-populated cache files from proxy mode, keyed by `<method>_<host>_<path>.json` |
| `.config/config.json` | ZEN token pool + OpenCode session persistence (tokens, session cookies, credentials) |
| `opencode-workspace.ts` | Workspace usage fetcher: fetches root page `/` and each workspace `/go`/`/workspace/{id}` page, extracts ALL `<script>` blocks for embedded `$R` workspace IDs + rolling/weekly/monthly usage. Falls back to `_server` RPC API. |
| `prototype/` | Analysis artifacts, extracted response structures, User-Agent breakdowns |

## Architecture: Interceptor Flow

```
Client → TLS Server (443) → secureConnection → parseHttpRequest
  → [Cache Interceptor] → loadFromCache → cached? → set req.response
  → [Fake Handler Interceptor] → handleDeviceLogin (vs-auth → auth → repo → ghcp-app → vs → copilot → catch-all) → handler matched? → set req.response
    → YES (req.response set): Return fake/cached response directly (no upstream call)
    → NO: Forward to upstream host (uses real IP, bypasses hosts redirect)
  → [Response Interceptor] → saveToCache → Send response back to client

**Priority**: Cache → VSAuth/Auth/Repo/GHCP/VS/Copilot handlers (per-client routing, VS-auth first for enterprise plan) → Catch-all → Upstream proxy

## Provider System (Model Routing)

The proxy supports **5 upstream model providers** determined by model ID prefix. Multiple providers can be active simultaneously via checkbox toggles in the dashboard.

| Provider | Prefix | Upstream | Auth | Notes |
|----------|--------|----------|------|-------|
| **OC-GO** | (none) | `https://opencode.ai/zen/go/v1` | OpenCode API key | Default premium provider |
| **OC-ZEN** | `-free` | `https://opencode.ai/zen/v1` | None | Currently throttled |
| **POLL** | `pol/` | `https://text.pollinations.ai/openai` | None | Free tier, no API key needed |
| **FREEBUFF** | `freebuff/` | `https://www.codebuff.com` (embedded pipeline) | Freebuff auth tokens (`FREEBUFF_TOKENS` env or `freebuffTokens` in config.json) | Routes directly to Codebuff free-tier API with session management, token pool, run chains. Models dynamically fetched from Codebuff GitHub, falls back to 7 hardcoded models. Dynamic User-Agent version detection. |
| **AGNES** | `agnes/` or `agnes-flash-2` | `https://apihub.agnes-ai.com` | AGNES API key (`cpk-...`) | Routes to Agnes AI API |

### Model ID Mapping

| Model Source | Example ID | Routes To |
|-------------|-----------|-----------|
| OpenCode Go | `deepseek-v4-pro` | `opencode.ai/zen/go/v1` |
| Pollinations | `pol/openai-fast` | `text.pollinations.ai` |
| Freebuff | `freebuff/deepseek/deepseek-v4-pro` | Codebuff free-tier (embedded pipeline) |
| Agnes | `agnes/agnes-2.0-flash` or `agnes-flash-2` | `apihub.agnes-ai.com` |

### How it Works

1. **`getModelTier(modelId)`** in `opencode-client.ts` determines the provider tier from the model ID string:
   - `startsWith("pol/")` → `poll`
   - `startsWith("freebuff/")` → `freebuff`
   - `startsWith("agnes")` or `=== "agnes-flash-2"` → `agnes`
   - `endsWith("-free")` or special names → `free`
   - everything else → `go`

2. **`chatCompletion()`** in `opencode-client.ts` routes to the correct upstream:
   - `poll` → `https://text.pollinations.ai/openai/chat/completions` (no key)
   - `freebuff` → embedded Codebuff pipeline in `freebuff-client.ts` (session mgmt, token pool, run chains)
   - `agnes` → `https://apihub.agnes-ai.com/chat/completions` (AGNES API key required)
   - `go` → `https://opencode.ai/zen/go/v1/chat/completions` (OpenCode API key)

3. **`initModels()`** fetches and caches per-provider model lists:
   - Go models from `opencode.ai/zen/go/v1/models`
   - Poll models from `text.pollinations.ai/models`
   - Freebuff models from Codebuff's GitHub TypeScript sources (`freebuff-models.ts`, `free-agents.ts`, `model-config.ts`) with hardcoded fallback (7 models: DeepSeek V4 Pro, DeepSeek V4 Flash, MiMo 2.5, MiMo 2.5 Pro, Kimi K2.6, MiniMax M2.7, MiniMax M3)
   - Cached to `.cache/models-{go,poll}.json`

4. **Dashboard grouping**: The dashboard WebSocket snapshot includes `providerTag` for each model ("go", "poll", "freebuff", "agnes", "zen", "bitnet", "openrouter") and renders them grouped by provider with headers: **OC-GO**, **POLL**, **FREEBUFF**, **AGNES**, **BITNET**, **OPENROUTER**, **OC-ZEN**.

5. **Provider toggles**: The dashboard Proxy Config section includes **checkbox toggles** for each provider (OC-GO, FREEBUFF, AGNES). Multiple providers can be active simultaneously. Active providers are persisted to `.config/config.json` as an array. **AGNES auto-activation**: When an AGNES API key is saved (via dashboard or directly in `config.json`), the `"agnes"` provider is automatically added to `_activeProviders` — no need to manually check the AGNES checkbox.

## All Intercepted Endpoints

### Auth Flow

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| POST | `/login/device/code` | Fake device code + user code `ABCD-1234`, auto-authorized | `auth-handler.ts:67` |
| POST | `/login/oauth/access_token` | Fake `gho_*` token with `expires_in`, `refresh_token`; supports form-urlencoded AND JSON bodies; auto-accepts unknown codes | `auth-handler.ts:127` |
| POST | `/login/oauth/authorize_app` | 302 redirect → `redirect_uri?code=...&state=...` | `auth-handler.ts:79` |
| GET | `/login/oauth/select_account` | 302 redirect → `redirect_uri?code=...&state=...` (auto-selects fake user) | `auth-handler.ts:93` |
| GET | `/login/oauth/authorize` | 302 redirect → `redirect_uri?code=...&state=...` (OAuth with PKCE) | `auth-handler.ts:110` |
| GET | `/login/device` | Redirect to account picker or show verification page | `auth-handler.ts:152` |
| GET | `/login/device/select_account` | HTML page with fake user account choice | `auth-handler.ts:248` |
| POST | `/login/device/select_account` | 302 redirect to `/login/device?skip_account_picker=true` | `auth-handler.ts:265` |
| GET | `/login/device/confirmation` | HTML page to enter device code | `auth-handler.ts:271` |
| POST | `/login/device/confirmation` | Validate code, show authorize page | `auth-handler.ts:288` |
| GET | `/login/device/authorize` | HTML authorize page | `auth-handler.ts:318` |
| POST | `/login/device/authorize` | 302 redirect to `/login/device/success` | `auth-handler.ts:332` |
| GET | `/login/device/success` | HTML success page | `auth-handler.ts:338` |
| GET | `/login/device/failure` | HTML failure page | `auth-handler.ts:350` |
| POST | `/login/device/verify-fake` | Internal auto-verify endpoint (auto-authorizes via JS) | `auth-handler.ts:166` |

### User Info

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| GET | `/user` | Full GitHub user object (`fake-copilot-user`, plan: business) | `auth-handler.ts:181` |
| GET | `/user/orgs` | Array with one fake org (full GitHub org object with node_id, all API URLs) | `auth-handler.ts:197` |
| POST | `/user/repos` | 201 Created with full repo JSON | `auth-handler.ts:220` |
| GET | `/user/*` (catch-all) | Empty `{}` | `auth-handler.ts:214` |

### Copilot

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| GET | `/copilot_internal/user` | Full fake user with: `chat_enabled`, `cli_enabled`, `copilot_plan: "individual"`, `is_mcp_enabled`, `analytics_tracking_id`, `assigned_date`, `organization_list`, `limited_user_quotas`, `monthly_quotas`, `endpoints` | `auth-handler.ts:493` |
| GET | `/copilot_internal/v2/token` | Full fake token with: `tid=...` format token, `sku=free_limited_copilot`, `individual`, `agent_mode_auto_approval`, `codesearch`, `limited_user_quotas`, `tracking_id`, `endpoints` | `auth-handler.ts:562` |
| GET | `/copilot_internal/v2/token?*` | Same as above (with query params) | `auth-handler.ts:568` |
| GET | `/copilot_internal/repository_search` | Array with one fake repo (flat format: `name_with_owner`, `owner_login`, `is_private`) | `auth-handler.ts:574` |

### GHCP App (github-app/* User-Agent)

The GitHub App for Windows (Rust, `github-app/*` User-Agent) is detected and routed through `handlers/ghcp-app/`. Currently serves models from `ghcp-app/models.ts` and defers auth to the default handler.

### Copilot Proxy API (api.individual.githubcopilot.com) — Non-VS/Non-GHCP

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| GET | `/v1/models` | List of available models (with thinking variants) | `copilot-handler.ts` |
| GET | `/models/{id}` | Specific model info | `copilot-handler.ts` |
| POST | `/v1/chat/completions` | SSE-streamed chat completion (forwards to opencode.ai) | `copilot-handler.ts` |
| POST | `/v1/messages` | Anthropic Messages API chat (forwards to opencode.ai, Copilot CLI) | `copilot-handler.ts` |
| GET | `/agents/sessions/*` | Agent session state (SSE) | `copilot-handler.ts` |
| GET/POST | `/mcp` | MCP endpoint | `copilot-handler.ts` |
| POST | `/completions` | Code completion | `copilot-handler.ts` |
| POST | `/v1/embeddings` | Embeddings | `copilot-handler.ts` |
| POST | `/v1/tokenize` | Tokenize | `copilot-handler.ts` |

### Visual Studio 2026 Copilot API (api.individual.githubcopilot.com)

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| POST | `/v1/messages` | Anthropic Messages API chat (forwarded to opencode.ai) | `vs/handler.ts` |
| POST | `/responses` | OpenAI Responses API chat (forwarded to opencode.ai) | `vs/handler.ts` |
| POST | `/chat/completions` | OpenAI Chat Completions (forwarded to opencode.ai) | `vs/handler.ts` |
| GET | `/models`, `/v1/models` | Model list (VS-specific format with `token_prices` billing, `model_picker_price_category`, fake `cat_*` category separator entries between provider groups, filters by `config.json` providers/disabledModels) | `vs/models.ts` |
| GET | `/models/{id}` | Specific model detail | `vs/models.ts` |
| GET | `/copilot_internal/user` | Enterprise plan user (VS-only, others get individual) | `vs/auth.ts` |
| GET | `/copilot_internal/v2/token` | Enterprise token (VS-only, others get free) | `vs/auth.ts` |
| GET | `/copilot_internal/content_exclusion` | Content exclusion settings | `vs/auth.ts` |

VS detected via `editor-version: VS/VisualStudio.*` header (case-sensitive). VS requests get **enterprise** responses (`copilot_plan: "enterprise"`, `sku: "enterprise"`). Non-VS clients (VS Code, CLI, browser) get **individual/free** responses.

**Critical routing detail**: `handleVSAuth()` in `device-login-emulator.ts` runs BEFORE `handleAuth()` so VS auth requests (user/token) are caught by the VS enterprise handler first. Previously `handleAuth()` ran first and returned individual/free responses even for VS clients. The VS chat/model handler (`handleVisualStudio`) falls after GHCP-app handler.

### Copilot Plans & SKUs

| `copilot_plan` | `access_type_sku` | Display | Quota Field |
|----------------|-------------------|---------|-------------|
| `individual` | `free_limited_copilot` | Copilot Free | `limited_user_quotas` |
| `individual` | `copilot_for_individual` | Copilot Pro | `limited_user_quotas` |
| `business` | `copilot_for_business_seat` | Copilot Business | `quota_snapshots` |
| `enterprise` | `copilot_enterprise_seat` | Copilot Enterprise | `quota_snapshots` |

Known SKU values from proxy capture: `free_limited_copilot`, `business`, `enterprise`, `max`. Plan display names: `individual`, `business`, `enterprise`, `max`. Billing `restricted_to` list: `pro`, `pro_plus`, `business`, `enterprise`, `max`.

VS uses `access_type_sku` for plan label display in UI. The `individual: true` field in the token response is required for VS to show the usage/quota section. Without it, VS shows "unable to retrieve".

See `skills.md` → **Copilot Plans, SKUs & Quota** for plan table, quota field format, and VS handler configuration.

Business/Enterprise plans use `quota_snapshots` instead of `limited_user_quotas` for quota data. Format:

**Free/Pro user:**
```json
{
  "login": "username",
  "access_type_sku": "free_limited_copilot",
  "assigned_date": "2024-12-30T11:30:17+08:00",
  "chat_enabled": true,
  "copilot_plan": "individual",
  "limited_user_quotas": { "chat": 450, "completions": 3500 },
  "monthly_quotas": { "chat": 500, "completions": 4000 },
  "limited_user_reset_date": "2026-02-28"
}
```

**Business/Enterprise user:**
```json
{
  "login": "username",
  "access_type_sku": "copilot_enterprise_seat",
  "assigned_date": "2024-01-15",
  "chat_enabled": true,
  "copilot_plan": "business",
  "quota_reset_date": "2025-02-01T00:00:00Z",
  "quota_snapshots": {
    "chat": { "entitlement": 0, "remaining": 0, "percent_remaining": 0, "unlimited": true, "overage_permitted": false, "overage_count": 0 },
    "completions": { "entitlement": 0, "remaining": 0, "percent_remaining": 0, "unlimited": true, "overage_permitted": false, "overage_count": 0 },
    "premium_interactions": { "entitlement": 1000, "remaining": 755, "percent_remaining": 75.5, "unlimited": false, "overage_permitted": true, "overage_count": 0 }
  }
}
```

### Model Name Emoji Conventions

Model display names in `ghcp-app/models.ts`, `copilot-handler.ts`, and `vs/models.ts` use a prefix emoji:

| Prefix | Emoji | Condition |
|--------|-------|-----------|
| Freebuff | `[🇫🇷ᴇᴇ]` | `id.startsWith("freebuff/")` |
| Has thinking variants (deepseek-v4, mimo) | `💡` | `supportsThinkingVariants(id)` — checks `deepseek-v4` or `mimo` without internal-thinking overlap |
| No thinking variants | `✨` | default |
| Has vision (modalities.input includes `"image"`) | `🎞️` | `modelHasVision(id)` — reads `modalities.input` from `models.dev/api.json` |
| Premium freebuff | `[LIM]` | `getFreebuffModelPremium(id)` — checks dynamic metadata or hardcoded `premium` flag |

Freebuff models use agent-based routing (no controllable thinking), so they never get `💡` regardless of model name. Premium freebuff models (DeepSeek V4 Pro, MiMo 2.5 Pro, Kimi K2.6) additionally show `[LIM]`.

Emojis are concatenated: base + media. Examples:
- `deepseek-v4-pro` (text-only, has variants) → `💡 DeepSeek V4 Pro`
- `mimo-v2.5` (image+audio+video, has variants) → `💡🎞️ MiMo V2.5`
- `kimi-k2.5` (image+video, no variants) → `✨🎞️ Kimi K2.5`
- `minimax-m2.7` (text-only, no variants) → `✨ MiniMax M2.7`
- `freebuff/deepseek/deepseek-v4-pro` (premium) → `[🇫🇷ᴇᴇ][LIM] DeepSeek V4 Pro`
- `freebuff/minimax/minimax-m2.7` (free) → `[🇫🇷ᴇᴇ] MiniMax M2.7`

Vision data sourced from `models.dev/api.json` at startup (`fetchModelCtxMap` → `_visionSet`). Models not in the API (e.g. `pol/openai-fast`) get no `🎞️`.

### Model Thinking Variants

Models that support controllable thinking (DeepSeek V4, MiMo) are duplicated with thinking level tags:

| Model ID | Display Name | Mapped `reasoningEffort` |
|----------|-------------|------------------------|
| `deepseek-v4` | DeepSeek V4 | (dropdown with all options) |
| `deepseek-v4 [LO]` | DeepSeek V4 [LO] | `"low"` |
| `deepseek-v4 [MD]` | DeepSeek V4 [MD] | `"medium"` |
| `deepseek-v4 [HI]` | DeepSeek V4 [HI] | `"high"` |
| `deepseek-v4 [MX]` | DeepSeek V4 [MX] | `"max"` |

For VS handler: if model display name with tag exceeds 24 chars, spaces are stripped from the base name (e.g. `Claude Opus 4.7 [HI]` → `ClaudeOpus4.7 [HI]`).

### Feedback

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| POST | `/repos/*/issues` | 201 Created (fake issue with feedback content) | `repo-handler.ts` |

### Updates

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| GET | `/repos/*/releases/latest` | Full release object with `latest.json` asset (repo: `github/app`, version `v0.2.6`) | `repo-handler.ts` |
| GET | `/repos/*/releases/assets/*` or `/repos/*/releases/download/*` | `latest.json` content (version `0.2.6`, all platforms) | `repo-handler.ts` |

### Web Pages

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| GET | `/` | Fake GitHub root page HTML | `auth-handler.ts:381` |
| GET | `/favicon.ico` | 204 No Content | `auth-handler.ts:404` |
| GET | `/_side-panels/user.json` | Side panel user JSON | `auth-handler.ts:390` |
| GET | `/notifications/indicator` | `{"count": 0}` | `auth-handler.ts:399` |
| GET | `/github-copilot/chat` | Fake Copilot chat HTML page | `auth-handler.ts:372` |
| GET | `/github-copilot/chat/entitlement` | Copilot chat entitlement JSON | `auth-handler.ts:363` |
| POST | `/_alive` | 204 No Content | `auth-handler.ts:243` |

### Session Events (Debug-Only)

| Method | Endpoint | Visibility | Handler |
|--------|----------|-----------|---------|
| POST | `/agents/sessions/*/events` | Debug-only (`d` key) | `copilot-handler.ts` |

Session events are internal background activity (agent state tracking, event streams). Hidden from main log by default — toggle with `d` to see them.

### Telemetry Block

| Method | Endpoint | Response | Handler |
|--------|----------|----------|---------|
| POST | `/telemetry` or `/telemetry/*` | 204 No Content, empty body | `device-login-emulator.ts:11` |

Telemetry is blocked in mock and hybrid modes (returns 204 immediately). In proxy mode the fake handler chain is skipped entirely, so telemetry passes through to the real endpoint.

### Catch-All

| Any | Any unhandled path | `{"ok": true, "message": "fake response"}` | `device-login-emulator.ts:20` |

## Launchers

| Script | Mode | Proxy | Use Case |
|--------|------|-------------|----------|
| `!ACTIVATE.cmd` / `start.cmd` | Unified | Varies | **Main launcher**. Accepts arg: mock (default), hybrid, proxy or 1/2/3. DNS flush + CA install. IIS auto-detect. Hot-switch modes with 1/2/3 in dashboard |
| `start-hybrid.cmd` | Hybrid | No | Standalone — normal GitHub browsing proxy, Copilot API fully mocked |
| `start-mock.cmd` | Mock | No | Standalone — pure offline mock, single fake user, no real GitHub calls at all |
| `start-proxy.cmd` | Proxy | Yes | Standalone — forward to real GitHub, capture ALL traffic to cache/ + log |
| `_start-node.cmd` | Mock | No | Node.js fallback — runs with Node when Bun unavailable. Supports mode switching via exit codes |
| `!REMOVE.cmd` | Cleanup | — | Kill proxy, clean hosts file, remove CA cert from store |
| `.dist/start-*.cmd` | Varies | Varies | Built distribution launchers. Auto-detect Windows Terminal and relaunch in WT tab unless `ENFORCE_CMD=1` |
| `.dist/service-*.exe` | Varies | Varies | C# service wrapper. Same WT auto-detect logic. Can also run as Windows Service |

## Build System (Standalone EXEs + Windows Service)

See `skills.md` → **Building & Deploying Standalone EXEs** for build commands, output layout, C# wrapper runtime detection, and Windows Service registration.

Output in `.dist\`:
- **Bun build**: `gc2xy` (standalone binary, ~112 MB), `service-*.exe` (C# launcher)
- **Node build**: `node` + `src/` + `node_modules/` (portable folder), `service-*.exe`

## User-Agent Breakdown (from captured traffic)

All intercepted traffic sources detected by User-Agent header:

| User-Agent | Source | Count |
|------------|--------|-------|
| `github-app/*` (e.g. `0.2.6`) | GitHub App for Windows (Rust, uses reqwest HTTP client) | 3534 |
| `Mozilla/5.0 ... Chrome/*` | Chrome browser | 1130 |
| `undici` | GitHub Copilot Desktop (Node.js backend) | 531 |
| `VSCopilotClient/*` | VS Code Copilot extension | 491 |
| `VSTeamExplorer-GitHub/*` | VS Team Explorer GitHub extension | 492 |

**Key insight**: The GitHub App (`github-app/*`) uses Rust reqwest. If it uses `rustls` (not `native-tls`), our CA cert won't be trusted even if installed in Windows cert store. The app constructs token exchange URLs using IP (`https://127.0.0.1/...`) rather than hostname.

## Web Dashboard

A web-based dashboard is available at `https://github.com/dashboard`. Built with **Bootstrap 5.3** and custom liquid glass effect (SVG displacement maps with Snell's law refraction, IOR 2.5). All live data is push-based via **WebSocket** (`ws://127.0.0.1:3441/ws`, piped through `wss://host/ws` from TLS handler) — no polling, changes delivered as deltas only.

### Layout
- **Left (col-lg-8)**: Available Models — family-grouped model tags (deepseek, xiaomi, alibaba, etc.) with enabled/disabled toggle, model ID overlay
- **Right (col-lg-4)**: API Key / ZEN Token Pool (pool cards with status badge), Quick Actions, Environment, Proxy Configuration

### Status Header
Replicates the TUI status bar with real-time values: mode (MOCK/HYBRID/PROXY), LReq (local proxy request count), TPS, active keys (active/total), models (enabled/total), **Quota** (combined workspace usage % for OpenCode / cost% for ZEN), provider. All inline in the header card with a dark `card-header` background. In OpenCode mode, Quota shows **remaining** monthly capacity as a percentage (100 - avg(usage%) across all workspaces). In ZEN mode, Quota shows cost/(cost+balance) %. Updates every 2s via WS.

### Provider Selector
Checkbox toggles (multiple can be active simultaneously):
- **OC-GO** — route through opencode.ai /zen/go (default, requires OpenCode API key)
- **FREEBUFF** — route through embedded Codebuff pipeline (session mgmt, token pool, run chains). Requires `FREEBUFF_TOKENS` env var or `freebuffTokens` in config.json, or auto-discovers tokens from Freebuff CLI credentials.
- **AGNES** — route through Agnes AI API at apihub.agnes-ai.com (requires AGNES API key). **Auto-activates** when an AGNES key is saved — checkbox is automatically checked and config row shown.

### Model Tiles
Compact horizontal checkbox tiles in a flex-wrap container. Models are **grouped by provider** (`go`, `poll`, `freebuff`) using the `providerTag` field from `getModelProviderTag()`:

- **Family normalization**: `getModelFamily()` in `opencode-client.ts` strips `thinking-` prefix, keeps text before first `-`, then strips trailing version digits. E.g. `deepseek-flash`/`deepseek-thinking` → `deepseek`, `minimax-m2`/`minimax-m2.5` → `minimax`, `qwen3.5`/`qwen3.6` → `qwen`.
- **Fallback**: API `family` first, then `MODEL_INFO[id].family`, else `""` which falls through to `id.split('/')[0]` in the HTML.
- Models show display names with:
  - 💡 prefix + small-caps thinking modes (ᴀ ʙ ᴄ ᴅ ᴇ ғ ɢ ʜ ɪ ᴊ ᴋ ʟ ᴍ ɴ ᴏ ᴘ ǫ ʀ s ᴛ ᴜ v ᴡ x ʏ ᴢ) for controllable thinking models (deepseek-v4 [ʟᴏ, ᴍᴅ, ʜɪ, ᴍx], mimo [ʟᴏ, ᴍᴅ, ʜɪ])
  - Base name only for non-thinking models (no emoji)
  - Model ID shown on hover via `title` attribute
  - Premium models locked with lock icon when no valid OpenCode key

### API Key Management
- **OpenCode** key validation: pings `https://opencode.ai/zen/go/v1/models` + billing API. Shows VALID/UNKNOWN badge. Keys masked as first 5 + `...` + last 4 chars.
- **ZEN** key management: Token pool with name/token/session cookies. CRUD via modal (add/edit/delete). Stats fetched from `api.zenllm.org/api/dashboard` using two-tier auth: session cookie (`zs=`) first, Bearer token (`sk-zenith-...`) fallback.
- Keys filtered by selected provider (only current provider's keys shown).

### ZEN Dashboard Auth

The dashboard fetches ZEN stats from `https://api.zenllm.org/api/dashboard` using a two-tier auth strategy:

1. **Session cookie** (`zs=<jwt>`): Tried first for each ZEN key's stored `session` field and the top-level `ZENITH_SESSION`
2. **Bearer token** (`Authorization: Bearer sk-zenith-...`): Fallback if all cookie attempts return 401

**`tryParseJwtExp(token)`** at `dashboard-handler.ts:80` decodes JWT payloads to check `exp` at module level. Used during `loadZenConfig()` to select the freshest non-expired session across all entries and `ZENITH_SESSION`. Base64url decoding uses standard base64 with `-/`→`+/` substitution.

**Provider auto-detection**: In `loadZenConfig()`, any token starting with `sk-zenith-` is automatically assigned `provider: "zen"` regardless of the saved `provider` field. This fixes the bug where dashboard keys were labeled `"opencode"` and invisible in ZEN provider mode.

### ZEN Top Bar Columns
When ZEN provider is active with a logged-in session, three extra inline columns appear in the status header: **Requests** (formatted with K/M suffix), **Tokens** (formatted with K/M suffix), **Used** (percentage + dollar cost). Hovering Used shows remaining balance. Columns show `n/a` when not on ZEN provider, `Loading...` when ZEN is selected but not yet logged in.

### Collapsible Sections
All cards (keys, config, models, actions, env) collapse with chevron toggle icons.

### Restart
Shows yellow pulsing "Reconnecting..." while WebSocket is disconnected. When WS reconnects, server sends full snapshot — declares online immediately.

### Wallpaper Switcher

The dashboard Proxy Configuration section includes a **Wallpaper** radio group with four options:
- **None** — plain black background
- **Bing** — daily Bing wallpaper, cached to `.cache/wallpaper-bing.jpg`
- **Wallhaven** — random SFW wallpaper from Wallhaven's monthly top list (page 3), cached to `.cache/wallpaper-haven.jpg`
- **AI (FreeGen)** — AI-generated wallpaper from a user prompt via `freegen.app` pipeline (prompt signer + image generator + WebSocket bridge). Cached to `.cache/wallpaper-freegen.jpg` with an atomic pending/current swap. Default prompt is `epic cinematic landscape, mountains at sunset, vibrant colors, ultra detailed, 16:9 wallpaper`.

Wallpapers are fetched on-demand when the WebSocket connects and cached for **1 hour** (FreeGen uses its own generation state and background refresh). The cached image is base64-encoded and pushed to the client as a **WebSocket `wallpaperData` message** with a `dataUri` field — the client applies it as a CSS background directly, no HTTP roundtrip. A `/api/bg` HTTP fallback endpoint exists server-side but is no longer used by the dashboard. Wallhaven uses the API at `https://wallhaven.cc/api/v1/search?categories=100&purity=100&topRange=1M&sorting=toplist&order=desc&page=3` and picks a random result.

The wallpaper source is stored in `localStorage` (`gc2xy_wallpaper`) and in `.config/config.json` (`wallpaper` field). On initial snapshot load, the radio button is auto-selected. The client stores the current `dataUri` in a global `_wallpaperDataUri` variable; when empty, non-AI wallpaper selections fall back to `/api/bg`.

#### AI Wallpaper Flow (Agnes)

`generateAiWallpaperToDisk()` in `dashboard-handler.ts:710`:

1. **Agnes API call** — `POST https://apihub.agnes-ai.com/v1/images/generations` with `model: agnes-image-2.1-flash`, the saved prompt, `size: 1024x768`, and `Authorization: Bearer <agnesKey>`. Up to 3 retries on 429/5xx. Aggressive console logging (`[AI WALLPAPER] attempt N/3 failed: ...`) on each attempt.
2. **CDN download** — Agnes returns `data[0].url` (e.g. `https://platform-outputs.agnes-ai.space/...`). The image is downloaded via the local `downloadInsecure()` helper which uses `node:https` with `rejectUnauthorized: false` (the Agnes CDN cert is self-signed). `response_format: b64_json` is **not** supported by the underlying `agnes-t2i-general-model` and returns 400, so URL is the only path.
3. **Bing fallback** — if the CDN download throws (corporate proxy block, Cloudflare 403, cert error, timeout), the proxy calls `fetchBingWallpaper()` and copies the daily Bing image to `.cache/ai-paper.jpg` so the AI slot isn't empty. It then broadcasts a **`wallpaperFallback`** WS message with `{ reason }`; the client shows a warning toast ("Agnes CDN blocked, using Bing wallpaper"). Generation still reports success (100% progress, no error toast) because the user got a wallpaper.
4. **Hard errors** — auth failures, rate limits, missing key, malformed response all hit the outer `catch` block which returns `false`, leaves progress at 0, and broadcasts a **`wallpaperError`** WS message with the upstream error string. The client shows a red error toast ("AI wallpaper failed: ..."). No Bing fallback in this case — those are user-fixable issues, not network blips.
5. **Success path** — only on full success does `setGenProgress("image", 100)` fire (the old code falsely reported 100% in `finally` regardless of outcome, masking every failure). Progress auto-resets to `{kind: null, progress: 0}` after 60s.

The 1-hour cache on `.cache/ai-paper.jpg` (via `fetchAiWallpaper()`) means successful Agnes generations are reused; the Bing fallback also lands in this file and is reused until the next generation attempt or prompt change (which calls `unlinkSync` to clear it).

#### FreeGen Wallpaper Flow

`generateFreegenWallpaperToDisk()` in `dashboard-handler.ts:

1. **Prompt signing** — `POST https://prompt-signer.freegen.app/api/test` obtains `{ ts, sig }`.
2. **Image generation** — `POST https://image-generator.freegen.app/api/test` with `{ prompt, ts, sig, ratio_id: "16:9" }`. Either returns `image_data_url` immediately or `job_id` for async jobs.
3. **WebSocket bridge** — if `job_id` is returned, subscribes via native WebSocket to `wss://websocket-bridge.freegen.app/ws` (Origin: `https://freegen.app`) and waits for `{type: "result", image_data: <url>}` or `{type: "error"}`.
4. **Download + atomic swap** — the image is downloaded to `.cache/wallpaper-freegen.pending.jpg`, then `renameSync` to `.cache/wallpaper-freegen.jpg` (prevents partial image exposure).
5. **Background refresh** — after serving `/dashboard` with the current FreeGen wallpaper embedded, a background refresh is queued to generate the next wallpaper for the following visit.

| WS Action | Purpose |
|-----------|---------|
| `setWallpaper` | Set wallpaper source, cache the image, push `wallpaperData` to client |
| `getBingBg` | Get current wallpaper (legacy name, works for all sources), push `wallpaperData` to client |
| `generateFreegenWallpaper` | Start FreeGen generation with prompt/ratio; broadcasts `wallpaperData` and progress |
| `wallpaperError` | (Server → client) Real Agnes/FreeGen failure (auth/rate-limit/parse); client shows red toast |
| `wallpaperFallback` | (Server → client) Agnes succeeded but CDN blocked; client shows warning toast, Bing image is displayed |

### API Endpoints

All read/status data is delivered via WebSocket push (delta-based, only on change). Only the HTML page and initial snapshot remain as HTTP endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard` or `/` | GET | Serve dashboard HTML page |
| `/api/init` | GET | Initial snapshot (status, models, keys, health) — called once on page load |

All mutations (toggle model, CRUD keys, set mode/provider, save/clear sessions, restart, generate FreeGen wallpaper, fetch wallpaper/zen stats/workspace usage) are sent as **WebSocket action messages** to `ws://127.0.0.1:3441/ws` (piped through `wss://host/ws` from TLS handler).

### Files
| File | Purpose |
|------|---------|
| `dashboard.html` | Web dashboard HTML (project root) |
| `src/handlers/dashboard-handler.ts` | Dashboard handler: serves HTML + JSON API endpoints. OpenCode key validation, ZEN key CRUD, Freebuff config (URL + API key), provider toggle, session login, stats aggregation, Bearer/cookie two-tier ZEN auth, ZEN model list, OpenCode workspace usage. **AI wallpaper** generation via Agnes API with **Bing fallback** when the Agnes CDN is unreachable (corporate proxy / WAF / self-signed cert). **FreeGen wallpaper** generation via `freegen.app` pipeline with atomic pending/current swap and WebSocket delivery. **WebSocket server** on `127.0.0.1:3441` (`gc2xy_WS_PORT`) — snapshot/diff push system pushes delta patches only when data changes, never polling. WS action handler for all mutations (toggle model, save config, key CRUD, restart, set provider, generate FreeGen wallpaper, etc.) |
| `src/opencode-workspace.ts` | Workspace usage fetcher: extracts workspace IDs + rolling/weekly/monthly usage from opencode.ai `/go` page `$R` data |
| `src/mitm-proxy.ts` | Routes `/dashboard` and `/api/*` in all modes (mock/hybrid/proxy). Detects `Upgrade: websocket` in TLS handler → pipes upgraded socket to WebSocket server on `WS_PORT` |

### Dashboard HTML Structure (`dashboard.html`)

#### Key DOM Containers
| ID | Purpose |
|----|---------|
| `apiKeysContainer` | Workspace cards render here (OPENCODE STATS section) |
| `quotaDisplay` | Quota % in status header (remaining monthly capacity) |
| `quotaTopBar` | Wrapper for quota display with label |
| `keysCountBadge` | Total API key count badge |
| `workspaceNamesList` | Datalist for key name autocomplete |

#### Key JavaScript Functions (in `dashboard.html`)
| Function | Line | Purpose |
|----------|------|---------|
| `renderOpencodeStats()` | ~1301 | Main workspace card renderer — builds `pool-card` divs with workspace name (hover: `wrk_` ID), key checkboxes, usage progress bars |
| `renderWorkspaceUsageSummary()` | ~1363 | Updates `#quotaDisplay` with remaining % (100 - avg usage) |
| `renderWorkspaceUsage(data)` | ~1291 | Entry point when WS `workspaceUsage` message arrives — stores `_wsData`, calls both render functions |
| `toggleWsKey(wsId, keyID, enabled)` | ~1297 | Sends `toggleWorkspaceKey` WS action |
| `applyKeys(k)` | ~1280 | Called when keys WS message arrives — updates `_wsData` and re-renders |
| `applySnapshot(data)` | ~1107 | Handles initial WS snapshot — sets `_wsData` from `workspaceData` field |
| `applyPatch(data)` | ~1162 | Handles WS delta patches — same logic for `workspaceData` |

#### Data Flow: Workspace Keys → Key Rotator + Provider Activation
```
Dashboard checkbox toggle
  → wsSend('toggleWorkspaceKey', { workspaceId, keyID, enabled })
  → dashboard-handler.ts:166 — updates _workspaceKeyStates[wsId]
  → syncKeysFromWorkspaceStates() — filters _keys to only enabled keys
    → setOcKeys(newKeys.map(k => k.key)) — pushes to opencode-client.ts balancer
    → if keys exist: adds "opencode" to _activeProviders (so ensureModels() serves them)
    → if no keys: removes "opencode" from _activeProviders (so ensureModels() skips them)
    → saveConfig() — persists providers + disabledModels to config.json
  → Next withKey() call uses only enabled keys
  → Next ensureModels() call filters by active providers → no keys = no OpenCode models served
```

### Keyboard Reference
The dashboard footer shows terminal keyboard shortcuts: `1`-`3` switch modes, `r` restart, `d` debug, `q` quit.

## Certificate Management

See `skills.md` → **Managing Certificates** skill for CA cert install, regeneration, and SAN details.

Current intercept cert SAN: `localhost`, `127.0.0.1` (IP), `github.com`, `www.github.com`, `api.github.com`, `api.githubcopilot.com`, `copilot-proxy.githubusercontent.com`, `api.individual.githubcopilot.com`, `origin-tracker.individual.githubcopilot.com`, `proxy.individual.githubcopilot.com`, `telemetry.individual.githubcopilot.com`.

## Windows Terminal Tab Color

The proxy sets WT tab to cyan via `settings.json` hot-reload (`split-console.ts:627`). Reads `profiles.defaults.tabColor`, saves it, writes `"#00FFFF"`, restores on exit. OSC 9 escape sent as fallback (blocked by ConHost on native Windows processes).

## Windows Terminal Auto-Relaunch & Cleanup

All launcher scripts (`!ACTIVATE.cmd`, `start.cmd`, `start-*.cmd`, `!REMOVE.cmd`) auto-detect legacy `cmd.exe`:
- If `WT_SESSION` is empty and `wt.exe` exists → relaunch as admin in a new Windows Terminal tab, then `exit` the original cmd.exe
- If `WT_SESSION` is already set (already in WT) or `wt.exe` not found → run as-is (Server 2016 fallback)

**Tab lifecycle cleanup** uses a PID file (`src/mitm-proxy.ts:929`):
1. On proxy startup, saves the terminal host PID (nearest `OpenConsole.exe`, `conhost.exe`, or `WindowsTerminal.exe` ancestor) to `.cache/proxy-host-pid`
2. Next run's cleanup reads this file → `taskkill /F /PID <pid>` → closes the previous proxy tab only (not the whole WT window, not other tabs)
3. The same file is used at shutdown (label `:end`) to self-close the current tab after a 2-second delay
4. File is deleted after use; repeated `taskkill` on an already-dead PID is harmless

On Server 2016 or systems without WT, the fallback is `timeout /t 3` then script exits — the cmd.exe window closes automatically.

## Cache System

- Module: `cache.ts`, Directory: `cache/`
- Filename: `<METHOD>_<host>_<path>.json` (sanitized, 200 char max)
- Format: `{ statusCode, statusMessage, headers, bodyBase64 }`
- Priority: Cache → Fake handlers → Catch-all → Upstream
- See `skills.md` → **Working with the Cache System** for cache ops and troubleshooting.

## Tool Salvager

`src/tool-salvager.ts` — repairs upstream LLM tool calls that don't match VS
schemas. **Inspired by [gc2oc](https://github.com/notBlubbll/gc2oc)'s
`normalizeToolCall` and `_tool400Streak` recovery** (see their
`src/server.js`).

Small/upstream LLMs (Agnes-2.0-Flash, Pollinations GPT-OSS 20B, Freebuff
Codebuff, etc.) routinely emit tool calls that fail to satisfy VS's
strict tool schema. The salvager runs **after the LLM response arrives**
and **before the response is converted to `tool_use` blocks** for VS.

### Four problems the salvager handles

| # | Problem | Example | Salvager action |
|---|---------|---------|-----------------|
| 1 | **Schema-drift** (wrong field names) | LLM calls `get_file` with `filePath` (Anthropic) instead of `filename` (VS) | Coerce aliases: `filePath`/`path`/`uri`/`resource` → `filename` |
| 2 | **Type-drift** (strings instead of numbers) | `"endLine": "100"` (string) instead of `100` (number) | Coerce `startLine`/`endLine` to numbers; default to `1` / `999999` for missing |
| 3 | **Broken JSON** (truncated content, Windows path escapes) | `{"content":"dir\ntl\file","filename":"foo` (unterminated) | Regex-extract `filename` / `content` / etc. from the broken blob |
| 4 | **Apology text** (model gives up) | `"I apologize, but I'm unable to retrieve the contents..."` | Inject synthetic `task_complete` tool_use so VS finalizes the turn |
| 5 | **Tool-call loop** (model stuck) | `get_file` called 5× in a row with `endLine: 500, -1, 100, 100, 0` | Inject `task_complete` to break the loop |

### Architecture

```
LLM response (OpenAI tool_calls[])
   ↓
repairToolCalls() — runs normalizeToolCall, falls back to salvageToolCall
   ↓
detectApologyText(content) — regex match for "I apologize / I can't / as an AI..."
   ↓
detectToolLoop(messages, candidate) — same tool name called ≥3 times in a row
   ↓
If (apology || loop) AND all tool calls dropped → buildAnthropicTaskComplete
If (apology || loop) AND tool calls salvageable → keep repaired calls, log it
Otherwise → return repaired tool calls as-is
```

### Public API

| Export | Purpose |
|--------|---------|
| `normalizeToolCall(tc)` | Stage A: schema coercion. Returns `tc` with coerced args, or `null` if `JSON.parse` failed |
| `salvageToolCall(tc)` | Stage B: regex-extract from broken JSON. Returns salvaged `tc` or `null` |
| `repairToolCall(tc)` | Combined: normalize → salvage. Always returns the best-effort result |
| `repairToolCalls(tcs)` | Apply to a list. Returns `{ repaired, dropped, total }` |
| `detectApologyText(text)` | `true` if text is an LLM refusal / "I can't" / "as an AI" pattern |
| `detectToolLoop(msgs, candidate)` | `true` if same tool name fired ≥3 times in last 4 assistant messages |
| `buildAnthropicTaskComplete(model)` | Returns SSE buffer with synthetic `task_complete` tool_use (Anthropic Messages format) |
| `buildOpenAITaskComplete(model)` | Returns OpenAI chat-completion object with synthetic `task_complete` tool_call |
| `bumpSalvageStat(kind)` | Diagnostic counter — `normalized` / `salvaged` / `dropped` / `apologyInjected` / `loopInjected` |
| `getSalvageStats()` | Read counters for logs / dashboard |

### Per-tool schema coverage

Coerced tools: `get_file` (VS), `read_file` (VS Code), `grep_search`,
`replace_string_in_file`, `multi_replace_string_in_file`, `create_file`,
`remove_file` / `delete_file(s)`, `run_command_in_terminal` /
`execute_command`, `get_background_terminal_output`, `get_terminal_output`,
`kill_terminal`, `semantic_search`, `fetch_webpage`, `runSubagent`,
`manage_todo_list`, `memory`, `vscode_listCodeUsages`, `vscode_renameSymbol`,
`vscode_askQuestions`, `run_vscode_command`, `create_and_run_task`,
`github_text_search`, `github_repo`, `open_browser_page`/Playwright tools,
`lookup_vs`, `find_symbol`, `plan`, `code_search`, `file_search`. Browser
tools (`open_browser_page` etc.) are pass-through.

Each tool has its own list of accepted field aliases — e.g. for `get_file`:
`filename ← filePath | path | uri | resource`.

### Integration points

| File | Where | Behavior |
|------|-------|----------|
| `src/handlers/vs/handler.ts` (`/v1/messages` non-stream) | After `resp.json()` | Run salvager on `openaiData.choices[0].message`; on `replacedWithTaskComplete`, return `buildAnthropicTaskComplete` SSE; else inject repaired `tool_calls` into `contentBlocks` |
| `src/handlers/vs/handler.ts` (`/v1/messages` stream) | After SSE accumulation | Repair accumulated `toolCallAccum[*]`; if all dropped + apology/loop, write `buildAnthropicTaskComplete` SSE and close socket |
| `src/handlers/vs/handler.ts` (`/responses` non-stream) | After `resp.json()` | Same as `/v1/messages` non-stream but returns `buildOpenAITaskComplete` for `replacedWithTaskComplete` |
| `src/handlers/vs/handler.ts` (`/chat/completions` non-stream) | After `resp.json()` | Same pattern; mutates `data.choices[0].message` in place |
| `src/handlers/copilot-handler.ts` (`/v1/messages` non-stream) | After `toolCalls` build, before conversion to `tool_use` | Repair `toolCalls`; on (apology/loop) + all-dropped, replace with `task_complete`; on pure apology text (no tool calls), also synthesize `task_complete` |
| `src/handlers/copilot-handler.ts` (`/responses` non-stream, SSE accumulation) | After stream accumulation → `data` build | Repair `msg.tool_calls`; same apology/loop/task_complete logic |
| `src/handlers/copilot-handler.ts` (`/responses` streaming to socket) | After stream completes, before `response.completed` | Buffer tool call SSE events; run salvager on accumulated tool calls; if apology/loop → emit `task_complete` output item instead; else flush buffered events |

### Diagnostic output

Console example (when salvager fires):
```
[TOOL SALVAGE] agnes-2.0-flash: 0/1 tool_calls repaired, 1 dropped
[TOOL SALVAGE] agnes-2.0-flash: apology → task_complete
```

For the specific agnes log case described by the user, this would have
broken the loop after 1-2 iterations instead of letting the model
apologize 8+ times in a row with `endLine` varying between `-1`, `0`,
`100`, `500`, `1000`.

## Nag Handling (task_complete suppression)

Visual Studio sends "You have not yet marked the task as complete using the task_complete tool" when the LLM produces text without calling `task_complete`. Three interception layers (gc2oc pattern):

### Mechanism

All handlers (`copilot-handler.ts`, `vs/handler.ts`) share these helpers from `shared.ts`:

| Helper | Purpose |
|--------|---------|
| `countConsecutiveNags(messages)` | Walks backwards counting consecutive nag user-messages |
| `stripNagMessages(messages)` | Filters nag messages from the conversation array |
| `RECENTLY_COMPLETED` | Map `model → timestamp` — drains follow-up requests after `task_complete` |

### Flow

1. **Nag detected** (`not yet (marked|complete)` in last user message): set `RECENTLY_COMPLETED[model]`, strip nag, return SSE stream with `task_complete` tool_use + `stop_reason: "tool_use"`
2. **Body dedup** (identical body within 30s): return `task_complete` immediately without LLM forward (uses `RECENT_BODIES` map with smart key of `model+msgCount+lastUserMsg`)
3. **Drain** (any request while `RECENTLY_COMPLETED[model]` < 20s): delete RC, return `task_complete` — covers "Task marked as complete" acknowledgment and retried original query
4. **No nag**: forward to LLM normally

### SSE Format

VS expects `event:` + `data:` lines in Anthropic Messages API SSE format:

```
event: message_start\ndata: {type:"message_start",...}\n
event: content_block_start\ndata: {type:"content_block_start",index:0,content_block:{type:"tool_use",name:"task_complete"}}\n
event: content_block_stop\ndata: {type:"content_block_stop",index:0}\n
event: message_delta\ndata: {type:"message_delta",delta:{stop_reason:"tool_use"}}\n
event: message_stop\ndata: {type:"message_stop"}\n
```

Nag responses return SSE buffer with `Content-Length` + `Connection: close` (not chunked encoding) to avoid corrupting the stream for VS.

## Recordings

- **`.recordings/`** — Recorded flows from dashboard `e` toggle, named `flow-<epoch>.json`
- **`.proxy-log/`** — Plain-text per-session traffic logs

## Token Exchange Handler

The `/login/oauth/access_token` handler (at `auth-handler.ts:127`) features:
- **Dual body parsing**: Tries `URLSearchParams` (form-urlencoded) first, falls back to `JSON.parse`
- **Auto-accept fallback**: If auth code not found in internal map, still returns a valid token (200, not 401)
- **Richer response**: Returns `access_token`, `token_type`, `scope`, `expires_in` (28800), `refresh_token`, `refresh_token_url`
- **Device flow**: Looks up device code in `activeDevices` map, returns `authorization_pending` while waiting, `access_token` when authorized
- **Debug logging**: Logs grant_type, truncated device_code/code on every request

## Hybrid Mode

Hybrid mode (`HYBRID_MODE=1`) allows normal web browsing of GitHub while mocking Copilot and auth APIs:

- **Browser pages** (`Accept: text/html` + GET): passed through to real GitHub (`handleAuth` returns `{ handled: false }` immediately)
- **API requests** (Copilot, auth tokens, user info): intercepted and mocked as usual
- **Catch-all**: returns `{ handled: false }` in hybrid mode, so unhandled requests pass through upstream

Mode label shows `HYBRID` in the status banner. `PASSTHROUGH` env var overrides hybrid mode.

## Restart Mechanism

Restart and mode switching use **exit codes** (no temp files):

| Key | Exit Code | Action |
|-----|-----------|--------|
| `r` | `42` | Restart (same mode) |
| `1` | `43` | Switch to MOCK |
| `2` | `44` | Switch to HYBRID |
| `3` | `45` | Switch to PASSTHROUGH |

Before exiting, the proxy **clears the module cache** (`require.cache`) so `bun run` re-compiles all TypeScript source files from disk — every restart picks up code changes.

See `skills.md` → **Restart & Mode Switching** for batch implementation details and restart flow.

### Live Mode Switch (`1`/`2`/`3` in dashboard)

Pressing `1`, `2` or `3` from the TUI is a **soft** switch: `mitm-proxy.ts:1225-1242` calls `setMode()` (in-memory only) and redraws the status bar. The traffic log filename (`traffic-<date>-<mode>.log`) is set once at startup (`mitm-proxy.ts:62-65`) and does **not** rename, so a `mock → proxy` switch keeps appending to the old `...-mock.log` file. The mode value used for the log filename and the in-memory mode can briefly disagree until restart. To get a fresh `...-PROXY.log` and a clean process, press `r` (restart) after switching — the launcher restarts with the matching `--mode-N` arg. The console key `3` was historically broken (emitted `switch:PROXY` uppercase, which fell through to `mock`); it now emits `switch:proxy` (`split-console.ts:594`) and routes correctly through `validModes` in `mitm-proxy.ts:1227`.

## Copilot Token

Generated by `generateCopilotToken()` at `auth-handler.ts:50`:
- **Real `tid=...` format** matching GitHub's actual token (not `ghu_*`)
- Includes: `exp`, `iat`, `sku`, `proxy-ep`, `st`, `chat=1`, `cit=1`, `malfil=1`, `editor_preview_features=1`, `agent_mode=1`, `agent_mode_auto_approval=1`, `mcp=1`, `ip`, `asn`, `rd` (reset date), `cq` (completions quota)
- 7-day expiry from current time
- Copilot token response (`auth-handler.ts:528` for non-VS, `vs/auth.ts:52` for VS):
  - **Non-VS** (VS Code, CLI, browser): `sku=free_limited_copilot`, `individual: true`, `limited_user_quotas`, `tracking_id`, `endpoints` (individual)
  - **VS** (Visual Studio): `sku=enterprise`, `limited_user_quotas` (42% used: chat=290, completions=2320), `code_review_enabled: true`, `copilotignore_enabled: true`, `endpoints` (individual)

## Copilot User Response

Fake `/copilot_internal/user` response differs by client:
- **Non-VS** (`auth-handler.ts:492`): `copilot_plan: "individual"`, `access_type_sku: "free_limited_copilot"`, `limited_user_quotas` (42% used: chat=290, completions=2320), `monthly_quotas` (total: chat=500, completions=4000), `can_upgrade_plan`, `can_signup_for_limited`, `endpoints` (individual)
- **VS** (`vs/auth.ts:17`): `copilot_plan: "enterprise"`, `access_type_sku: "enterprise"`, `copilotignore_enabled: true`, `can_upgrade_plan: false`, `limited_user_quotas` (42% used: chat=290, completions=2320), `monthly_quotas` (total: chat=500, completions=4000), `limited_user_reset_date: "2120-01-01"`, `endpoints` (individual — same interceptable hosts)

## Interceptor System

```typescript
// Add a request interceptor — can set req.response to short-circuit
addRequestInterceptor(async (req) => {
  if (someCondition) {
    req.response = { statusCode: 200, statusMessage: "OK", headers, body };
  }
});

// Add a response interceptor — can modify upstream responses
addResponseInterceptor(async (res) => {
  // modify res.statusCode, res.headers, res.body
});
```

Interceptors register at startup in `mitm-proxy.ts`:
1. **Cache interceptor** (line 352): loads from `cache/` before anything else
2. **Device login interceptor** (line 368): runs fake handler logic — auth → repo → ghcp-app → vs → copilot → catch-all (skips entirely if `req.response` already set by cache)

See `skills.md` → **Interceptor Development** for detailed handler chain priority and contract.

## Env Variables

> **Always use `.config/config.json` for configs, API keys, and provider settings** (e.g. `opencodeKey`, `pollApiKey`, `freebuffTokens`, `wallpaper`, `providers`, `disabledModels`, `workspaceKeyStates`). The `.env` file is reserved for runtime/process flags only (port overrides, mode, IIS auto-detect, ENFORCE_NODE/ENFORCE_CMD). Never put secrets or per-provider keys in `.env` — they are persisted via the dashboard UI or by editing `config.json` directly. Each provider client reads its key from `config.json` (e.g. `getPollKey()` in `pollinations-client.ts`).

| Variable | Default | Description |
|----------|---------|-------------|
| `gc2xy_MODE` | `mock` | Set by launcher: `mock`, `hybrid`, or `proxy`. Also set on mode switch via dashboard. Display-only; actual mode determined by `--mode-2`/`--mode-3` launch args |
| `IIS_PROXY` | unset | Set to `"1"` to enable IIS reverse proxy mode (HTTP only, skips TLS on 443). Auto-set by launchers when W3SVC detected. |
| `gc2xy_HTTP_PORT` | `3080` (IIS) / `80` | Port for HTTP intercept server. Launchers set to `3080` when IIS detected. |
| `gc2xy_HTTPS_PORT` | `443` | Port for HTTPS/TLS intercept server. |
| `gc2xy_WS_PORT` | `3441` | Port for dashboard WebSocket server (dedicated `http.Server`). |
| `gc2xy_SETUP_DONE` | unset | Internal flag — set by launcher after first-run setup (cleanup/DNS/CA) to skip on restarts |
| `FAKE_DEVICE_LOGIN` | `"0"` (enabled) | Set to `"0"` to DISABLE the emulator |
| `TARGET_HOST` | `github.com` | Target host to intercept |
| `INTERCEPT_MODE` | `hosts` | `hosts` for system-wide or `proxy` for HTTP_PROXY mode |
| `PROXY_PORT` | `8080` | Port for proxy mode |
| `LOG_DIR` | `./proxy-logs` | Log output directory |
| `CERT_DIR` | `./certs` | Certificate storage directory |
| `PASSTHROUGH` | unset | Set to `"1"` to forward to real GitHub (no fake responses) — deprecated, use `--mode-3` for proxy mode |
| `HYBRID_MODE` | unset | Set to `"1"` to enable hybrid mode: browser pages proxy, API/Auth mocked — deprecated, use `--mode-2` |
| `RECORD_MODE` | unset | Set to `"1"` to auto-start recording all traffic |
| `SKIP_CACHE` | unset | Set to `"1"` to skip reading from cache |
| `OPENCODE_API_KEYS` | unset | JSON array of opencode.ai API keys for model forwarding |
| `OPENCODE_API_KEY` | unset | Single opencode.ai API key (alternative to array) |
| `FREEBUFF_TOKENS` | unset | Comma-separated Freebuff auth tokens for Codebuff free-tier (or set `freebuffTokens` in config.json). Auto-discovers CLI tokens from `~/.config/manicode/credentials.json`. |
| `ZENITH_API_KEY` | unset | ZEN API key (`sk-zenith-...`) from zenllm.org |
| `ZENITH_SESSION` | unset | ZEN session cookie (`zs=...`) for dashboard stats |
| `OPENCODE_SESSION` | unset | OpenCode `auth` cookie value for workspace usage tracking in dashboard |
| `VS_ENABLE_TIME` | `true` | Set to `"0"` to disable prepending `[HH:MM:SS]` to VS agent responses |
| `ENFORCE_NODE` | `0` | Set to `"1"` to force Node.js runtime even if Bun is available. Affects all launchers and the C# service wrapper. |
| `ENFORCE_CMD` | `0` | Set to `"1"` to force plain cmd.exe and skip Windows Terminal auto-detect. Affects all batch launchers, `.dist/start-*.cmd`, the C# service wrapper, and proxy status bar detection. |
| `MCP_WRITE` | `true` | Set to `"0"` (or `false`/`no`/`off`) to disable auto-patching of SSMS Copilot MCP configs (`SQLtools__ExecutionMode: READ_ONLY → READ_WRITE`). Set `"1"` (or `true`/`yes`/`on`) to force-enable. Default `true` if unset. Also configurable via `.config/config.json` `MCP_WRITE` boolean. |

### `ENFORCE_CMD` Details

When unset (default), all launchers auto-detect Windows Terminal:
- Batch scripts (`!ACTIVATE.cmd`, `start-*.cmd`, `_start-node.cmd`): check `wt.exe` on PATH and relaunch in a new WT tab as admin.
- `.dist/start-*.cmd`: same logic -- if `wt.exe` exists and `WT_SESSION` is not set, opens the service EXE in a WT tab.
- C# service wrapper (`service-*.exe`): `TryLaunchInWT()` checks `WT_SESSION` and `ENFORCE_CMD`, then spawns `wt.exe new-tab` with the service path.

When set to `1`:
- All launchers skip WT relaunch and run directly in the current console (plain `cmd.exe`).
- The proxy status bar shows `cmd.exe` (via `detectHost()` process-tree walk) instead of `wterm.exe`.
- Useful on Server 2016 or systems without Windows Terminal, or when you explicitly want a legacy console window.

### `ENFORCE_NODE` Details

When unset (default), launchers prefer Bun if `~\.bun\bin\bun.exe` exists, otherwise fall back to Node.js.
When set to `1`:
- All launchers skip Bun detection and use Node.js exclusively.
- The C# wrapper also skips Bun standalone and portable checks, going straight to Node.js from PATH or the bundled `node` binary.
- Set this before running any launcher: `set ENFORCE_NODE=1` in cmd, or add `ENFORCE_NODE=1` to `.config/.env`.

## Console Dashboard

The proxy uses a gc2xy-style dashboard TUI with a sticky status banner and scrollable live log.
The dashboard width fills the terminal window (no cap). Resize events trigger an immediate redraw.

```
┌─ gc2xy ───────────────────────────────────────────────────────────┐
│                                                                   │
│ █▀▀▀ █▀▀▀ █▀▀█ █▀▀█ █▀▀▀ │ POLL: pol/openai-fast                   │
│ █ ▀█ █      ▀█ █░░█ █░░░ │ OC-GO: minimax-m2.7, kimi-k2.5         │
│ ▀▀▀▀ ▀▀▀▀ █▄▄█ ▀▀▀▀ ▀▀▀▀ │ deepseek-v4-pro, deepseek-v4-flash    │
│                           │ OTHER: bitnet-demo                     │
├───────────────────────────────────────────────────────────────────┤
│ github copilot proxy v3 │ Mode: MOCK │ Req: 0 │ ● 0.0 t/s │ Agent: GitHub Copilot Desktop ... │
├───────────────────────────────────────────────────────────────────┤
│ Commands: 1=mock 2=hybrid 3=proxy  ● X.X t/s ○ e=rec r=rst d=dbg m=mdls ... │
└───────────────────────────────────────────────────────────────────┘
```

### Console Model Grouping

The status banner right column groups models into colored label rows in this order:
- **POLL** (yellow) — `pol/*` (Pollinations free tier)
- **FREEBUFF** (yellow) — `freebuff/*` (Codebuff free-tier)
- **FEATHERLESS** (magenta) — `featherless/*` (Featherless)
- **OC-GO** (magenta) — all default `opencode.ai/zen/go` models (catchall)
- **OTHER** (magenta) — `bitnet-demo`, `bitnet/*` (misc non-OC-GO upstreams)

Rows that have no models are omitted entirely (no empty headers).

See `skills.md` → **Using the Console Dashboard** for keyboard shortcuts, log format, TPS details, log levels, and debug-only entries.

## Known Behaviors

- **Batch script style**: All launcher scripts use `goto`-based control flow instead of parenthesized `if/else` blocks. This avoids cmd.exe parse errors caused by unmatched parentheses inside `echo` text containing URLs (e.g. `https://bun.sh`) or `::` comments inside blocks. Scripts must NOT contain `::` comment lines (use `rem` or no comments) as they can break block parsing on some Windows versions.
- **Node.js tsx runner**: Scripts use `node node_modules\tsx\dist\cli.cjs` instead of `npx tsx` or `node node_modules\.bin\tsx.cmd`. The `.cmd` wrapper cannot be executed via `node` (tries to parse batch as JavaScript), and `npx` prompts for installation on first use.
- **`windivert` removed**: The unused `windivert` native module was removed from `package.json`. It required `node-gyp` (Python + VC++ build tools) and blocked `npm install` in Node.js fallback mode.
- **IIS auto-detection**: All launcher scripts check `sc query w3svc | findstr "RUNNING"` at startup. If W3SVC is running, `IIS_PROXY=1` and `gc2xy_HTTP_PORT=3080` are set automatically, and port 80/443 cleanup is skipped (IIS owns those ports). The status banner shows `Port: 443 → 3080` when IIS mode is active.
- **IIS site start retry**: After `iisreset`, WAS may not be ready immediately. `!ACTIVATE.cmd` retries `start apppool` + `start site` up to 5 times with 1s delays, checking for `state:Started` each time. The `appcmd` output for pool/site start is suppressed (both named `gc2xy` which was confusing); the meaningful confirmation is `IIS site started successfully.` from the retry check.
- **IIS global SSL binding cleanup**: Previous versions registered `ipport=0.0.0.0:443` (non-SNI) which poisoned ALL other IIS sites on port 443. Current version uses only SNI `hostnameport=` bindings and aggressively cleans up leftover `0.0.0.0:443` and `[::]:443` bindings on both activate and remove.
- **IIS other-site preservation**: `iis-preserve-sites.ps1` reads `applicationHost.config` (using `$cfg.configuration['system.applicationHost']` — the bracket syntax is required because the element name contains a dot), finds non-gc2xy sites with HTTPS:443 bindings, matches their hostnames to SSL certs in `LocalMachine\My` (handles wildcard certs like `*.toshibatec-tgis.com` matching `dexx-dev04.toshibatec-tgis.com` by extracting the parent domain), and registers them as SNI bindings via `netsh http add sslcert hostnameport=<host>:443`.
- **Chrome DNS-over-HTTPS bypass**: Chrome's Secure DNS (DoH) resolves hostnames via Cloudflare/Google DoH servers, completely bypassing the OS hosts file. `!ACTIVATE.cmd` sets `HKLM\SOFTWARE\Policies\Google\Chrome\DnsOverHttpsMode=off` to force OS DNS. **Users must close ALL Chrome windows and reopen** for the policy to take effect. Symptom: `ping github.com` shows `127.0.0.1` but Chrome shows real GitHub.
- **IIS mode always patches hosts file**: The hosts file redirect is required even in IIS mode — the browser must resolve `github.com` → `127.0.0.1` to reach IIS. `!ACTIVATE.cmd` always verifies and patches the hosts file (previously skipped in IIS mode), plus flushes DNS cache.
- TLS server uses ALPN `http/1.1` only (no HTTP/2)
- `Connection: close` is forced on all responses (no keep-alive for intercepted flows)
- Transfer-encoding, connection, keep-alive headers are stripped from upstream responses
- Request bodies > 3000 chars are truncated in the plain-English log; `bodyPreview` stores first 1000 chars in JSON log
- The record/replay console uses stdin and runs in background alongside the proxy (legacy; use cache.ts instead)
- Chrome may show `ERR_CERT_AUTHORITY_INVALID` if CA cert regenerated without reinstalling to Windows store; must reinstall via `certutil -addstore Root certs\ca-cert.pem`
- After CA install, close Chrome fully (right-click → Exit, not just close window) and reopen in Incognito mode to clear cached SSL errors
- If Chrome shows "scrambled credentials" (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`), verify cert SAN has no malformed IP entries (type 7 with string value)
- **GitHub App uses `https://127.0.0.1/...` for token exchange** (not `github.com`). Our intercept cert must include `127.0.0.1` as IP SAN (type 7 with raw bytes). If the app uses `rustls` (not `native-tls`), our CA may not be trusted regardless of SAN.
- Cache uses hostname in filename; requests arriving with hostname `127.0.0.1` will NOT match cache entries saved under `github.com` or `api.github.com`. This is by design — cache is for matching exact routes.
- **TCP body accumulation**: TLS server now waits for `Content-Length` bytes before processing the request (fix for large POST bodies split across TCP packets). Previously only the first TCP chunk was read, causing truncated JSON bodies and "No messages in request" errors for chat completions.
- **Body slicing respects Content-Length**: `forwardWithInterceptor` now slices `buffer.slice(bodyOffset, bodyOffset + contentLen)` instead of `buffer.slice(bodyOffset)`. The old code could include leftover TCP bytes after the Content-Length boundary, resulting in malformed JSON bodies and `System.Text.Json.JsonException: 'e' is invalid after a value` in VS.
- **Visual Studio detection**: Requests with `editor-version: VS/VisualStudio.*` header are logged with `[VS DETECTED]` prefix and routed through `vs/auth.ts` (auth endpoints) and `vs/handler.ts` (chat/models). VS gets **enterprise** plan responses from `vs/auth.ts` and `vs/models.ts`. `handleVSAuth()` runs before `handleAuth()` in the interceptor chain so VS auth requests are caught by the enterprise handler, not the individual/free one. **SSMS** (SQL Server Management Studio) is detected as a VS-family client via `editor-version: VS/SSMS.*` or `x-interaction-type: *SSMSAgent*` — `isVSShell()` returns true (enterprise auth) and `isSQLStudio()` returns true (chat delegation spoofs `editor-version: VS/VisualStudio.17.SQLStudio` then delegates to `handleVisualStudio`).
- **Non-VS clients** (VS Code, browser, CLI): Get **individual/free** plan responses from `auth-handler.ts` and `copilot-handler.ts`.
- **GitHub App detection**: `github-app/*` User-Agent triggers GHCP-specific routing through `handlers/ghcp-app/`.
- **Model name shortening**: For VS handler, if model display name + thinking tag exceeds 17 chars, spaces are stripped from the base name (e.g. `Claude Opus 4.7 [HI]` → `ClaudeOpus4.7[HI]`). Tags are dynamic: try full word first, then short form, then small-caps/symbol. Format: `✨Name￤ᴍx` (base) / `★Name￤ʟᴏ` (thinking).
- **Model format differs by platform**: VS models served by `vs/models.ts` (uses `token_prices` billing for free models, `multiplier` for premium, `model_picker_price_category` for pricing tiers, `policy.state` for access control). Non-VS models served by `copilot-handler.ts`. GHCP models served by `ghcp-app/models.ts`. All three now filter by `config.json` `providers` (active providers) and `disabledModels`. - **Category separator entries**: `vs/models.ts` inserts fake `cat_*` model entries between provider groups using model clone (`{...template, id, name}`) so they're structurally identical to real models. When selected in chat, `vs/handler.ts` returns "This is a [name] category. Please choose a model from it." - **Config filtering**: `ensureModels()` in `vs/models.ts` and `copilot-handler.ts` reads `config.json` to filter models by active providers (`providers` array) and disabled models (`disabledModels` map). Inactive provider models and disabled models are excluded from the response.
- **VS model fallback no longer filters MiniMax**: The `detectVendor(m.id) !== "MiniMax"` guard was removed from `vs/handler.ts`. All models including MiniMax are eligible as fallback when the requested model isn't available.
- **All request params forwarded upstream**: `opencode-client.ts` previously used a whitelist for extra params (reasoningEffort, temperature, max_tokens, etc.). Now `const body: any = { ...extra }` forwards **everything** from the incoming request body. Processed fields (model, messages, tools, stream) override their extra counterparts. This ensures `tool_choice`, `parallel_tool_calls`, `user`, and any VS-specific fields reach the upstream LLM.
- **Tool schema compression**: `opencode-client.ts` compresses all tool `parameters`/`input_schema` before forwarding upstream. Strips `description`, `title`, `markdownDescription`, `examples` from all nested schema objects. Preserves only structural fields: `type`, `properties`, `items`, `required`, `enum`, `const`, `anyOf`/`oneOf`/`allOf`, `additionalProperties`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`, `format`, `default`. This significantly reduces token usage in tool definitions.
- **DeepSeek "Enable required" fix**: In `vs/models.ts`, `getPolicy()` deepseek models return `state: "enabled"` (not `"disabled"`) so they don't show the "Enable required" label in VS. Other premium models (Claude Opus, Codex, etc.) remain `"disabled"`. Copilot-handler and GHCP models already use `state: "enabled"` for all models.
- **Billing multiplier formula**: For VS models (`vs/handler.ts`, `vs/models.ts`): `multiplier = realCtx / 100 + 0.01`. Real context length fetched from `models.dev/api.json` on startup. Non-VS/GHCP models use raw context value directly. Only `.01` decimal precision is reliably displayed by VS.
- **Log sanitization**: `_pushLog` and patched `console.log` strip `\n` from entry text, collapse whitespace, and drop empty entries to prevent blank lines in the console dashboard (`split-console.ts:238-243`, `split-console.ts:690`).
- **Debug-only log routing**: The console filters noisy internal traffic based on three rules (toggle with `d` to see all):
  - **Handler console.log** calls: only messages starting with a known-noisy prefix are debug-only: `[RESP BODY]`, `[REASONING CACHE]`, `[FAKE GHE]`, `[FAKE DEVICE LOGIN]`, `[FAKE DEVICE]`, `[RECORD]`, `[REPLAY]`, `[MOCK V1/MESSAGES]`, `[MOCK FALLBACK]`, `[VISUAL STUDIO]`, `[VS SESSION]`, `[COPILOT SESSION]`. All other `[` messages (model info, forwarding confirmations) show without debug (`split-console.ts:746`).
  - **Agent tag routing** in `logPlainEnglish`: traffic from `APP` (GitHub App), `VS` (Visual Studio), `TEAM` (VS Team Explorer), and `GO-HT` (Go HTTP client, e.g. Ollama updater) agents is always debug-only (`mitm-proxy.ts:87-89`).
  - **URL path routing** in `logPlainEnglish`: `/telemetry` and `/agents/sessions/*` URLs are always debug-only (`mitm-proxy.ts:89`).
- **TLS error demotion**: `ECONNRESET`, `EPIPE` and `ECONNABORTED` on the client TLS socket are demoted from `ERROR` to `DEBUG` (`mitm-proxy.ts:880-887, 1032-1038`). These fire routinely when a browser cancels navigation, an idle keep-alive socket is GC'd, or a scanner probes port 443 — they are not real errors. The first TLS handler also checks `requestHandled` so post-response resets stay quiet while pre-handshake aborts still surface as `ERROR`.

## SSMS Copilot MCP Auto-Patcher

On startup, the proxy discovers every SSMS Copilot MCP config on disk — scanning `C:\Program Files*` and `C:\Program Files (x86)*` for `Microsoft SQL Server Management Studio*\*\Common7\IDE\Extensions\Microsoft\SSMS.CopilotUiTools\McpServer\mcp.json` — and flips `SQLtools__ExecutionMode` from `READ_ONLY` to `READ_WRITE`. This exposes the `mssql_execute_write_query` tool (and the rest of the 27-tool set) so the Copilot agent inside SSMS can execute CREATE/ALTER/INSERT/UPDATE/DELETE, not just read.

| Aspect | Detail |
|--------|--------|
| Module | `src/mcp-writer.ts` — `discoverSsmsMcpConfigs()` scans fixed drives C..Z, `patchSsmsMcpConfig(path)` flips the env var in-place with `.bak` backup |
| Wire-in | `mitm-proxy.ts:1317` — runs after `createWsServer()` on every startup/restart |
| Config flag | `.config/config.json` `MCP_WRITE` (boolean, default `true`). Set `MCP_WRITE: false` to disable. |
| Env override | `process.env.MCP_WRITE` — `0|false|no|off` disables, `1|true|yes|on` forces enable regardless of config.json |
| Idempotent | Yes — if the file is already `READ_WRITE`, logs `[MCP-WRITE] already READ_WRITE` and does not rewrite. If `READ_ONLY`, patches and writes `mcp.json.bak` (only if no `.bak` exists yet). |
| Log prefix | `[MCP-WRITE]` (shown without debug mode) |

### Discovery algorithm

1. Enumerate fixed drives C: through Z: via `existsSync("${letter}:\\")`.
2. For each drive, list `Program Files` and `Program Files (x86)` for entries matching `/^Microsoft SQL Server Management Studio/i`.
3. For each SSMS install dir, list subdirectories (e.g. `22\Release`, `22\Preview`) and check each for `Common7\IDE\Extensions\Microsoft\SSMS.CopilotUiTools\McpServer\mcp.json`.
4. Deduplicate results, patch each file.

### Per-file patch logic

- Read JSON, walk `servers.*.env.SQLtools__ExecutionMode`.
- If value is `READ_ONLY` → set to `READ_WRITE`, mark touched.
- If value is already `READ_WRITE` → skip (no rewrite).
- If value is anything else → skip that server (don't override unknown modes).
- If touched and no `.bak` exists → copy original to `mcp.json.bak`.
- Write JSON back with 2-space indent.

## Critical Context

- User's GitHub login: **notBlubbll**.
- VS Code GitHub App client_id: `Ov23ctr1Udn5GokVCVJf`.
- Real Copilot API endpoints: `api.githubcopilot.com`, `api.individual.githubcopilot.com`, `origin-tracker.individual.githubcopilot.com`, `proxy.individual.githubcopilot.com`, `telemetry.individual.githubcopilot.com`.
- Real IPs: Resolved via DNS-over-HTTPS at startup (bypasses hosts file, queries Google/Cloudflare directly). Falls back to hardcoded values if DoH fails: `140.82.121.4` (github.com), `140.82.121.3` (www.github.com), `140.82.121.5` (api.github.com), `140.82.114.21` (api.githubcopilot.com), `140.82.113.22` (api.individual.githubcopilot.com, origin-tracker.individual.githubcopilot.com), `140.82.113.21` (telemetry.individual.githubcopilot.com), `4.225.11.192` (copilot-proxy.githubusercontent.com, proxy.individual.githubcopilot.com).
- Real OAuth token (captured): `gho_...xxxxxxxx`.
- Real copilot token format: `tid=...;exp=...;iat=...;sku=free_limited_copilot;...`.
- CA cert at `certs/ca-cert.pem` must be in Windows Trusted Root store.
- After deleting `certs/intercept-cert.pem` + `certs/intercept-key.pem`, restart to regenerate with updated SAN.

## How To Use

### Unified Launcher (Recommended)
Run `!ACTIVATE.cmd` or `start.cmd` as Administrator with optional mode argument:
```
!ACTIVATE.cmd          # Default: mock mode
!ACTIVATE.cmd hybrid   # Hybrid mode (browse proxy, API mocked)
!ACTIVATE.cmd 3        # Proxy mode (numeric arg also works)
```

Or just double-click `!ACTIVATE.cmd` (defaults to mock). Switch modes live with `1`/`2`/`3` in the dashboard. Restart with `r` — source changes are always picked up because `bun run` re-compiles from scratch.

### Node.js Fallback (When Bun Not Available)
Run `_start-node.cmd` as Administrator to run with Node.js:
```
_start-node.cmd
```
Auto-detects IIS, supports mode switching via exit codes (dash `1`/`2`/`3` keys switch modes).

### Mock Mode (Offline)
1. Run `!ACTIVATE.cmd` or `start-mock.cmd` as Administrator
2. All traffic served from cache (if available) or fake handlers
3. Single fake user: `fake-copilot-user`

### Hybrid Mode (Browse GitHub + Mocked Copilot)
1. Run `!ACTIVATE.cmd hybrid` or `start-hybrid.cmd` as Administrator
2. Normal GitHub browsing passes through to real GitHub
3. Copilot Chat API and auth are fully mocked

### Proxy Mode (Capture Real Traffic)
1. Run `!ACTIVATE.cmd proxy` or `start-proxy.cmd` as Administrator
2. Use GitHub normally (device login, Copilot, etc.)
3. All upstream responses auto-save to `cache/` as JSON with base64 body
4. Stop proxy with Ctrl+C

### Cleanup
Run `!REMOVE.cmd` as Administrator to kill proxy, clean hosts file, and remove CA cert.

### Build Standalone EXEs (Windows Service Support)
Run `build.cmd` from the project root to produce `.dist\` with standalone executables. See `skills.md` → **Building & Deploying Standalone EXEs** for full details.

### Troubleshooting
See `skills.md` → **Troubleshooting Proxy Issues** for cert, cache, token, and process issues.

## Console Log Filtering

Messages are filtered as debug-only (hidden unless `d` pressed) based on a denylist of known-noisy prefixes: `[RESP BODY]`, `[REASONING CACHE]`, `[FAKE GHE]`, `[FAKE DEVICE LOGIN]`, `[FAKE DEVICE]`, `[RECORD]`, `[REPLAY]`, `[MOCK V1/MESSAGES]`, `[MOCK FALLBACK]`, `[VISUAL STUDIO]`, `[VS SESSION]`, `[COPILOT SESSION]`.

All other `console.log` output (handler forwarding confirmations, model info) shows without debug mode.

Agent tag routing in `logPlainEnglish`: traffic from `APP` (GitHub App), `VS` (Visual Studio), `TEAM` (VS Team Explorer), and `GO-HT` (Go HTTP client) agents is always debug-only. URL path routing: `/telemetry` and `/agents/sessions/*` URLs are always debug-only.
