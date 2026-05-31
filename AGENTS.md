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

## IIS Reverse Proxy Mode (Alternative)

Instead of hosts file + raw TLS, gc2xy can run behind IIS:
- **Auto-detected**: If W3SVC (World Wide Web Publishing Service) is running, all launcher scripts automatically set `IIS_PROXY=1` and `gc2xy_HTTP_PORT=3080`
- Manual: Set `IIS_PROXY=1` — only the HTTP server runs (IIS handles TLS termination)
- `web.config` provides URL Rewrite rules forwarding all intercepted hosts to `http://127.0.0.1:3080`
- Defaults to port `3080` via `gc2xy_HTTP_PORT` env var (downstream code default is `3080`, not `8080`)
- Status bar shows `Port: 443 → 3080` when IIS mode is active
- HTTP handler detects `x-forwarded-proto: https` from IIS to upstream correctly as HTTPS

### IIS Service Recovery

```batch
sc config w3svc start= auto
sc start w3svc
sc failure w3svc reset= 86400 actions= restart/5000/restart/10000/restart/30000
```

## Key Files

| File | Purpose |
|------|---------|
| `!ACTIVATE.cmd` | **Unified launcher**: DNS flush, CA install, mode selection (mock/hybrid/proxy). IIS detection, Bun/Node fallback. Passes `--mode-2`/`--mode-3` launch args |
| `start.cmd` | Shorthand wrapper that calls `!ACTIVATE.cmd` with optional mode arg |
| `start-mock.cmd` | Standalone mock launcher (auto-elevate, IIS detect, Bun/Node fallback) |
| `start-hybrid.cmd` | Standalone hybrid launcher (same features) |
| `start-proxy.cmd` | Standalone proxy launcher (same features) |
| `_start-node.cmd` | Node.js-only fallback launcher (auto-elevate, IIS detect, mode switching via exit codes, no Bun required) |
| `!REMOVE.cmd` | Kill proxy, clean hosts, remove CA cert (IIS-aware port cleanup) |
| `mitm-proxy.ts` | Main proxy: TLS/HTTP servers, hosts redirect, interceptor engine, request forwarding, cache integration, **deletes `package-lock.json` on startup** (avoids stale lock) |
| `cache.ts` | Auto-cache: saves upstream responses to `cache/<sanitized-url>.json`; loads before fake handlers in mock mode |
| `split-console.ts` | Console dashboard TUI: status banner with model column, log buffer, keyboard commands, debug/record/restart toggles, mode switching, terminal resize handling, **Windows Terminal tab color** via `settings.json` hot-reload |
| `handlers/anthropic-bridge.ts` | Anthropic→OpenAI request conversion via `llm-bridge` library (system prompt, tool_use/tool_result, thinking blocks) |
| `handlers/device-login-emulator.ts` | Route dispatcher: vs-auth → auth → repo → ghcp-app → vs → copilot → catch-all (`handleVSAuth` runs first so VS gets enterprise plan) |
| `handlers/auth-handler.ts` | All auth endpoints: device login, OAuth PKCE, user info, copilot user/token, CORS preflight (individual/free responses) |
| `llm-bridge` (npm) | External library for Anthropic↔OpenAI translation (`anthropicToUniversal`, `universalToOpenAI`, streaming parsers/emitters) |
| `handlers/opencode-client.ts` | Core LLM forwarding client: API key balancer, model init, tool normalization, **forwards all request params upstream** (no whitelist) |
| `handlers/copilot-handler.ts` | All Copilot API routes: sessions, messages, MCP, models, completions, embeddings, tokenize (non-VS/non-GHCP) |
| `handlers/vs/handler.ts` | Visual Studio chat endpoints: `/v1/messages`, `/responses`, `/chat/completions` |
| `handlers/vs/auth.ts` | Visual Studio enterprise auth: copilot user, token, content exclusion |
| `handlers/vs/models.ts` | Visual Studio model list (matches real GitHub API format, includes thinking variants) |
| `handlers/ghcp-app/index.ts` | GitHub App (Windows) route dispatcher: detects `github-app/*` User-Agent |
| `handlers/ghcp-app/auth.ts` | GHCP app auth helpers and detection |
| `handlers/ghcp-app/models.ts` | GHCP app model list format |
| `handlers/repo-handler.ts` | Repository operations: issues, comments, reactions, releases, assets, feedback |
| `shared.ts` | Shared types (`HttpResponse`, `HandlerInput`, `HandlerResult`) and helpers |
| `record-replay.ts` | Record/replay console for capturing and replaying HTTP flows (legacy; cache.ts is the modern replacement) |
| `build.cmd` | **Unified build**: auto-detects Bun or Node.js, delegates to `build-bun.cmd` or `build-node.cmd` |
| `build-bun.cmd` | Bun standalone build: compiles TS → single `gc2xy` exe + C# service wrapper |
| `build-node.cmd` | Node.js portable build: copies src/ + node_modules/ + node.exe + C# service wrapper |
| `bunfig.toml` | Bun runtime config: telemetry off, small heap mode, no install cache |
| `.config/.env` | Environment configuration (API keys) |
| `certs/` | Auto-generated CA key/cert and unified multi-SAN intercept cert |
| `.proxy-logs/` | Daily traffic log files with JSON entries + `bodyPreview` (first 1000 chars) |
| `.cache/` | Auto-populated cache files from proxy mode, keyed by `<method>_<host>_<path>.json` |
| `.config/config.json` | ZEN token pool persistence (tokens, session cookies, credentials) |
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
| GET | `/models`, `/v1/models` | Model list (VS-specific format with thinking variants) | `vs/models.ts` |
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

Model display names in `ghcp-app/models.ts` and `copilot-handler.ts` use a prefix emoji based on capabilities from models.dev:

| Capability | Emoji | Condition |
|-----------|-------|-----------|
| Has thinking variants (deepseek-v4, mimo) | `💡` | `supportsThinkingVariants(id)` — checks `deepseek-v4` or `mimo` without internal-thinking overlap |
| No thinking variants | `✨` | default |
| Has vision (modalities.input includes `"image"`) | `🎞️` | `modelHasVision(id)` — reads `modalities.input` from `models.dev/api.json` |

Emojis are concatenated: base + media. Examples:
- `deepseek-v4-pro` (text-only, has variants) → `💡 DeepSeek V4 Pro`
- `mimo-v2.5` (image+audio+video, has variants) → `💡🎞️ MiMo V2.5`
- `kimi-k2.5` (image+video, no variants) → `✨🎞️ Kimi K2.5`
- `minimax-m2.7` (text-only, no variants) → `✨ MiniMax M2.7`

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

A web-based dashboard is available at `http://github.com/dashboard` (or `http://localhost:{HTTP_PORT}/dashboard`). Built with **Bootstrap 5.3** and custom liquid glass effect (SVG displacement maps with Snell's law refraction, IOR 2.5).

### Layout
- **Left (col-lg-8)**: Available Models — family-grouped model tags (deepseek, xiaomi, alibaba, etc.) with enabled/disabled toggle, model ID overlay
- **Right (col-lg-4)**: API Key / ZEN Token Pool (pool cards with status badge), Quick Actions, Environment, Proxy Configuration

### Status Header
Replicates the TUI status bar with real-time values: mode (MOCK/HYBRID/PROXY), LReq (local proxy request count), TPS, active keys (active/total), models (enabled/total), Requests (ZEN dashboard), Tokens (ZEN), Used (ZEN % + $ cost, remaining balance on hover), provider. All inline in the header card with a dark `card-header` background. ZEN columns show `n/a` when provider is OpenCode, `Loading...` when ZEN is selected but not logged in. Updates every 5 seconds.

### Provider Selector
Horizontal radio button group:
- **OpenCode** — route through opencode.ai
- **ZEN** — route through zenllm.org

### Model Tiles
Compact horizontal checkbox tiles in a flex-wrap container. Models are **grouped by vendor family** using the `family` field from `models.dev/api.json`:

- **Family normalization**: `getModelFamily()` in `opencode-client.ts` strips `thinking-` prefix, keeps text before first `-`, then strips trailing version digits. E.g. `deepseek-flash`/`deepseek-thinking` → `deepseek`, `minimax-m2`/`minimax-m2.5` → `minimax`, `qwen3.5`/`qwen3.6` → `qwen`.
- **Fallback**: API `family` first, then `MODEL_INFO[id].family`, else `""` which falls through to `id.split('/')[0]` in the HTML.
- Models show display names with:
  - 💡 prefix + small-caps thinking modes (ᴀ ʙ ᴄ ᴅ ᴇ ғ ɢ ʜ ɪ ᴊ ᴋ ʟ ᴍ ɴ ᴏ ᴘ ǫ ʀ s ᴛ ᴜ v ᴡ x ʏ ᴢ) for controllable thinking models (deepseek-v4 [ʟᴏ, ᴍᴅ, ʜɪ, ᴍx], mimo [ʟᴏ, ᴍᴅ, ʜɪ])
  - Base name only for non-thinking models (no emoji)
  - Model ID shown on hover via `title` attribute
  - Premium models locked with lock icon when no valid OpenCode key

### API Key Management
- **OpenCode** key validation: pings `https://opencode.ai/zen/go/v1/models` + billing API. Shows VALID/UNKNOWN badge. Keys masked as first 5 + `...` + last 4 chars.
- **ZEN** key management: Token pool with name/token/session cookies. CRUD via modal (add/edit/delete). Stats fetched from `api.zenllm.org/api/dashboard` using session cookies.
- Keys filtered by selected provider (only current provider's keys shown).

### ZEN Top Bar Columns
When ZEN provider is active with a logged-in session, three extra inline columns appear in the status header: **Requests** (formatted with K/M suffix), **Tokens** (formatted with K/M suffix), **Used** (percentage + dollar cost). Hovering Used shows remaining balance. Columns show `n/a` when not on ZEN provider, `Loading...` when ZEN is selected but not yet logged in.

### Collapsible Sections
All cards (keys, config, models, actions, env) collapse with chevron toggle icons.

### Restart
Shows yellow pulsing "Reconnecting..." while polling `/api/status` every 2s. Requires two consecutive successful responses before declaring online (prevents premature "Online" during initialization).

### Bing Background
Fetches daily Bing wallpaper via `https://www.bing.com/HPImageArchive.aspx` at startup.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Status + mode + model list + key validity |
| `/api/config` | GET/POST | Get/set config (mode, provider, keys, model states) |
| `/api/provider` | GET/POST | Get/set upstream provider |
| `/api/models` | GET/POST | Get/set model enabled states |
| `/api/keys/validate` | POST | Validate all OpenCode keys |
| `/api/keys` | GET/POST | ZEN token pool CRUD (add/update/delete keys with name/token/session) |
| `/api/zen/login` | GET/POST/DELETE | ZEN session cookie management + OAuth URLs |
| `/api/zenith/requests` | GET | ZEN dashboard aggregate stats (requests, tokens, cost, balance) |
| `/api/restart` | POST | Trigger restart (exit code 42, picks up code changes) |
| `/api/bg` | GET | Fetch Bing daily wallpaper URL |
| `/health` | GET | Health check (status, version, cwd, platform, runtime, hasValidKey) |

### Files
| File | Purpose |
|------|---------|
| `dashboard.html` | Web dashboard HTML (project root) |
| `handlers/dashboard-handler.ts` | Dashboard handler: serves HTML + JSON API endpoints. OpenCode key validation, ZEN key CRUD, session login, stats aggregation |
| `src/mitm-proxy.ts` | Routes `/dashboard` and `/api/*` in all modes (mock/hybrid/proxy) |

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
1. On proxy startup, saves the terminal host PID (nearest `OpenConsole.exe`, `conhost.exe`, or `WindowsTerminal.exe` ancestor) to `.proxy-host-pid`
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

| Variable | Default | Description |
|----------|---------|-------------|
| `gc2xy_MODE` | `mock` | Set by launcher: `mock`, `hybrid`, or `proxy`. Also set on mode switch via dashboard. Display-only; actual mode determined by `--mode-2`/`--mode-3` launch args |
| `IIS_PROXY` | unset | Set to `"1"` to enable IIS reverse proxy mode (HTTP only, skips TLS on 443). Auto-set by launchers when W3SVC detected. |
| `gc2xy_HTTP_PORT` | `3080` (IIS) / `80` | Port for HTTP intercept server. Launchers set to `3080` when IIS detected. |
| `gc2xy_HTTPS_PORT` | `443` | Port for HTTPS/TLS intercept server. |
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
| `ZENITH_API_KEY` | unset | ZEN API key (`sk-zenith-...`) from zenllm.org |
| `ZENITH_SESSION` | unset | ZEN session cookie (`zs=...`) for dashboard stats |
| `VS_ENABLE_TIME` | `true` | Set to `"0"` to disable prepending `[HH:MM:SS]` to VS agent responses |
| `ENFORCE_NODE` | `0` | Set to `"1"` to force Node.js runtime even if Bun is available. Affects all launchers and the C# service wrapper. |
| `ENFORCE_CMD` | `0` | Set to `"1"` to force plain cmd.exe and skip Windows Terminal auto-detect. Affects all batch launchers, `.dist/start-*.cmd`, the C# service wrapper, and proxy status bar detection. |

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
│ █▀▀▀ █▀▀▀ █▀▀█ █▀▀█ █▀▀▀ │ Free: pol/openai-fast                  │
│ █ ▀█ █      ▀█ █░░█ █░░░ │ Premium: minimax-m2.7, kimi-k2.5       │
│ ▀▀▀▀ ▀▀▀▀ █▄▄█ ▀▀▀▀ ▀▀▀▀ │ deepseek-v4-pro, deepseek-v4-flash    │
│                           │ qwen3.6-plus, mimo-v2-pro              │
├───────────────────────────────────────────────────────────────────┤
│ github copilot proxy v3 │ Mode: MOCK │ Req: 0 │ ● 0.0 t/s │ Agent: GitHub Copilot Desktop ... │
├───────────────────────────────────────────────────────────────────┤
│ Commands: 1=mock 2=hybrid 3=proxy  ● X.X t/s ○ e=rec r=rst d=dbg m=mdls ... │
└───────────────────────────────────────────────────────────────────┘
```

See `skills.md` → **Using the Console Dashboard** for keyboard shortcuts, log format, TPS details, log levels, and debug-only entries.

## Known Behaviors

- **Batch script style**: All launcher scripts use `goto`-based control flow instead of parenthesized `if/else` blocks. This avoids cmd.exe parse errors caused by unmatched parentheses inside `echo` text containing URLs (e.g. `https://bun.sh`) or `::` comments inside blocks. Scripts must NOT contain `::` comment lines (use `rem` or no comments) as they can break block parsing on some Windows versions.
- **Node.js tsx runner**: Scripts use `node node_modules\tsx\dist\cli.cjs` instead of `npx tsx` or `node node_modules\.bin\tsx.cmd`. The `.cmd` wrapper cannot be executed via `node` (tries to parse batch as JavaScript), and `npx` prompts for installation on first use.
- **`windivert` removed**: The unused `windivert` native module was removed from `package.json`. It required `node-gyp` (Python + VC++ build tools) and blocked `npm install` in Node.js fallback mode.
- **IIS auto-detection**: All launcher scripts check `sc query w3svc | findstr "RUNNING"` at startup. If W3SVC is running, `IIS_PROXY=1` and `gc2xy_HTTP_PORT=3080` are set automatically, and port 80/443 cleanup is skipped (IIS owns those ports). The status banner shows `Port: 443 → 3080` when IIS mode is active.
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
- **Visual Studio detection**: Requests with `editor-version: VS/VisualStudio.*` header are logged with `[VS DETECTED]` prefix and routed through `vs/auth.ts` (auth endpoints) and `vs/handler.ts` (chat/models). VS gets **enterprise** plan responses from `vs/auth.ts` and `vs/models.ts`. `handleVSAuth()` runs before `handleAuth()` in the interceptor chain so VS auth requests are caught by the enterprise handler, not the individual/free one.
- **Non-VS clients** (VS Code, browser, CLI): Get **individual/free** plan responses from `auth-handler.ts` and `copilot-handler.ts`.
- **GitHub App detection**: `github-app/*` User-Agent triggers GHCP-specific routing through `handlers/ghcp-app/`.
- **Model name shortening**: For VS handler, if model display name + thinking tag exceeds 17 chars, spaces are stripped from the base name (e.g. `Claude Opus 4.7 [HI]` → `ClaudeOpus4.7[HI]`). Tags are dynamic: try full word first, then short form, then small-caps/symbol. Format: `✨Name￤ᴍx` (base) / `★Name￤ʟᴏ` (thinking).
- **Model format differs by platform**: VS models served by `vs/models.ts` (matches real GitHub API format with correct `policy.state`, `billing.multiplier`, `reasoning_effort`). Non-VS models served by `copilot-handler.ts`. GHCP models served by `ghcp-app/models.ts`.
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
