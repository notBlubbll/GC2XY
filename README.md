# gc2xy — MITM Debug Proxy with Copilot Auth Bypass + ZEN

System-wide HTTPS interception proxy for `github.com` and Copilot subdomains. Decrypts traffic, fakes GitHub/Copilot API responses to bypass authentication. Supports **dual upstream providers**: [opencode.ai](https://opencode.ai) and [ZEN (zenllm.org)](https://zenllm.org).

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) or [Node.js](https://nodejs.org) (v18+), Administrator rights

```
git clone <repo>
cd gc2xy

!ACTIVATE.cmd [mode]        # Unified launcher: mock|hybrid|proxy or 1|2|3 (auto-detects Bun/Node/IIS)
start-mock.cmd              # Pure offline mock (no real GitHub calls)
start-hybrid.cmd            # Hybrid mode (browse proxy, API mocked)
start-proxy.cmd             # Proxy mode (forward to real GitHub, capture to .cache/)
_start-node.cmd             # Node.js-only fallback (when Bun unavailable)
start.cmd                   # Shorthand — prompts for mode then calls !ACTIVATE.cmd
!REMOVE.cmd                 # Kill proxy, clean hosts, remove CA cert
```

## Directory Structure

| Path | Purpose |
|------|---------|
| `src/` | TypeScript source |
| `.config/` | Environment config (`.config/.env` — API keys, `.config/config.json` — ZEN token pool) |
| `.certs/` | Auto-generated CA + intercept certs |
| `.recordings/` | Captured HTTP flow recordings |
| `.cache/` | Upstream response cache (auto-populated in proxy mode) |
| `.proxy-logs/` | Plain-English traffic logs |
| `src/handlers/` | Handler modules for auth, copilot, repo, VS, GHCP app, dashboard |
| `src/handlers/vs/` | Visual Studio enterprise plan handlers |
| `src/handlers/ghcp-app/` | GitHub App (Windows) handlers |

## How It Works

1. **Hosts file redirect**: All intercepted hosts (`github.com`, Copilot subdomains) → `127.0.0.1`
2. **TLS server on port 443** (or **IIS reverse proxy** on port 3080 when IIS detected): Intercepts HTTPS
3. **HTTP server on port 80** (or configurable HTTP port): Intercepts plain HTTP
4. **Interceptor chain**: Dashboard → Cache → VSAuth → Auth → Repo → GHCP → VS → Copilot → Catch-all → Upstream proxy
5. **Chat completions** forward to **opencode.ai** or **ZEN (zenllm.org)** models via the LLM client, depending on selected provider

## Operation Modes

| Mode | Description |
|------|-------------|
| **mock** (default) | All traffic served from cache or fake handlers. No real GitHub calls. |
| **hybrid** | Browser pages proxy to real GitHub. API/auth/Copilot endpoints mocked. |
| **proxy** | Forward everything to real GitHub. Captures responses to cache. |

Switch modes live in the dashboard with radio buttons.

## IIS Mode

gc2xy can run behind IIS as a reverse proxy target — IIS handles TLS termination, gc2xy handles interception.

- **Auto-detected**: If W3SVC (World Wide Web Publishing Service) is running, all launcher scripts automatically set `IIS_PROXY=1` and `gc2xy_HTTP_PORT=3080`
- Manual: Set `IIS_PROXY=1` env var (only HTTP server runs, no TLS server)
- Defaults to port `3080` (configurable via `gc2xy_HTTP_PORT`)
- `web.config` provides URL Rewrite rules that reverse-proxy all intercepted hosts to `http://127.0.0.1:3080`
- Status bar shows `Port: 443 → 3080` when IIS mode is active
- HTTP handler detects `x-forwarded-proto: https` from IIS and forwards upstream as HTTPS accordingly

### IIS Service Recovery

Configure W3SVC to auto-start and never stop:
```
sc config w3svc start= auto
sc start w3svc
sc failure w3svc reset= 86400 actions= restart/5000/restart/10000/restart/30000
```

## Launcher Scripts

| Script | Description |
|--------|-------------|
| `!ACTIVATE.cmd` | **Unified launcher**: DNS flush, CA install, mode selection, IIS auto-detection, Bun/Node fallback. Passes `--mode-2`/`--mode-3` launch args. |
| `start.cmd` | Shorthand wrapper — prompts for mode then calls `!ACTIVATE.cmd`. |
| `start-mock.cmd` | Standalone mock mode launcher (auto-elevates, detects IIS, Bun/Node fallback). |
| `start-hybrid.cmd` | Standalone hybrid mode launcher. |
| `start-proxy.cmd` | Standalone proxy mode launcher. |
| `_start-node.cmd` | Node.js-only fallback launcher (auto-elevates, IIS detection, mode switching via exit codes). |
| `!REMOVE.cmd` | Kill proxy, clean hosts file, remove CA cert. |
| `build.cmd` | Build standalone EXEs (Bun or Node.js). Output in `.dist/`. |

## Intercepted Hosts

`github.com`, `www.github.com`, `api.github.com`, `api.githubcopilot.com`, `copilot-proxy.githubusercontent.com`, `api.individual.githubcopilot.com`, `origin-tracker.individual.githubcopilot.com`, `proxy.individual.githubcopilot.com`, `telemetry.individual.githubcopilot.com`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IIS_PROXY` | — | Set to `"1"` to enable IIS reverse proxy mode (HTTP only, no TLS server). Auto-set when W3SVC detected. |
| `gc2xy_HTTP_PORT` | `3080` (IIS) / `80` | Port for HTTP intercept server. |
| `gc2xy_HTTPS_PORT` | `443` | Port for HTTPS/TLS intercept server. |
| `OPENCODE_API_KEYS` | — | JSON array of opencode.ai API keys |
| `OPENCODE_API_KEY` | — | Single opencode.ai API key (alternative) |
| `ZENITH_API_KEY` | — | ZEN API key (`sk-zenith-...`) from zenllm.org |
| `ZENITH_SESSION` | — | ZEN session cookie (`zs=...`) for dashboard stats |
| `gc2xy_MODE` | `mock` | Mode display label |
| `FAKE_DEVICE_LOGIN` | `"0"` (enabled) | Set to `"1"` to DISABLE the emulator |
| `INTERCEPT_MODE` | `hosts` | `hosts` for system-wide or `proxy` for HTTP_PROXY mode |
| `PROXY_PORT` | `8080` | Port for proxy mode |
| `LOG_DIR` | `./.proxy-logs` | Log output directory |
| `CERT_DIR` | `./.certs` | Certificate storage directory |
| `RECORD_MODE` | — | Set to `"1"` to auto-start recording |
| `SKIP_CACHE` | — | Set to `"1"` to skip reading from cache |
| `VS_ENABLE_TIME` | `true` | Set to `"0"` to disable timestamps in VS agent responses |
| `ENFORCE_NODE` | `0` | Set to `"1"` to force Node.js runtime even if Bun is available |
| `ENFORCE_CMD` | `0` | Set to `"1"` to force plain cmd.exe and skip Windows Terminal auto-detect |

### `ENFORCE_CMD` and `ENFORCE_NODE`

**`ENFORCE_CMD=1`** forces all launchers to use plain `cmd.exe` instead of auto-detecting Windows Terminal:
- Batch scripts (e.g. `!ACTIVATE.cmd`, `_start-node.cmd`) skip the `wt.exe` relaunch logic.
- `.dist/start-*.cmd` runs the service EXE directly instead of opening a WT tab.
- The C# service wrapper (`service-*.exe`) skips `TryLaunchInWT()`.
- The proxy status bar shows `cmd.exe` instead of `wterm.exe`.
- Useful on systems without Windows Terminal (Server 2016) or when you want a legacy console window.

**`ENFORCE_NODE=1`** forces all launchers to use Node.js instead of Bun:
- Launchers skip Bun detection entirely.
- The C# wrapper skips Bun standalone/portable and uses Node.js from PATH or the bundled binary.
- Set via `set ENFORCE_NODE=1` or add to `.config/.env`.

## Client Detection

| Client | Detection | Plan |
|--------|-----------|------|
| **Visual Studio** | `editor-version: VS/VisualStudio.*` header | Enterprise |
| **VS Code** | `user-agent: VSCopilotClient/*` | Individual/Free |
| **GitHub App (Windows)** | `user-agent: github-app/*` | Individual (via GHCP handler) |
| **Copilot Desktop** | `user-agent: undici` | Individual/Free |
| **VS Team Explorer** | `user-agent: VSTeamExplorer-GitHub/*` | Enterprise |
| **Browser** | `accept: text/html` | Individual/Free |

## Web Dashboard

Available at `http://github.com/dashboard`. Built with **Bootstrap 5.3** + liquid glass UI (SVG displacement maps, Snell's law refraction).

- **Header bar**: Mode (Mock/Hybrid/Proxy), LReq (local proxy requests), TPS, Keys, Models (enabled/total), Requests (ZEN), Tokens (ZEN), Used (ZEN — % + $ cost, remaining balance on hover), Provider (OpenCode/ZEN)
- **Left column (col-lg-8)**: Model tiles grouped by normalized family from `models.dev/api.json` (e.g. `deepseek`, `minimax`, `qwen`, `mimo`), 💡 prefix + ID display
- **Right column (col-lg-4)**: API Key token pool (OpenCode keys with VALID badge / ZEN pool with session status), Quick Actions, Environment, Proxy Configuration (mode + provider radio buttons)
- **ZEN integration**: Requests, Tokens, Used inline in top bar (formatted K/M), fetched from `api.zenllm.org/api/dashboard` via session cookies. Shows `n/a` when provider is OpenCode, `Loading...` when ZEN selected but not logged in. ZEN token pool with inline CRUD management modal (add/edit/delete keys, session cookies)
- **Provider selector**: Radio button group — OpenCode (routes through opencode.ai) or ZEN (routes through zenllm.org). Switching provider changes the key management section and model list.
- **Collapsible cards**, restart with reconnecting polling, Bing daily wallpaper background

## Console Dashboard

Status banner at top, live log below. Chat requests show as colored lines: `[tag][session]>[provider/model] — "preview" → [ms]` (pending shows `— …`, completed shows `→ [ms]`). Debug entries (noisy handler logs, VS/GHCP/telemetry traffic) hidden unless `d` pressed.

Keyboard shortcuts:

| Key | Action |
|-----|--------|
| `1` | Switch to MOCK mode |
| `2` | Switch to HYBRID mode |
| `3` | Switch to PROXY mode |
| `r` | Restart proxy |
| `d` | Toggle debug entries (handler noise, VS/GHCP/telemetry) |
| `q` | Quit |
| ↑↓ PgUp/PgDn | Scroll log |

## Nag Handling (task_complete suppression)

Visual Studio sends "You have not yet marked the task as complete" when the LLM produces text without calling `task_complete`. The proxy blocks these at three levels:

1. **Nag detected** — returns `task_complete` tool_use in SSE stream (Anthropic Messages API format with `event:` + `data:` lines)
2. **Body dedup** — identical request body within 30s gets `task_complete` immediately (no LLM forward)
3. **Drain** — any request within 20s of a `task_complete` response returns `task_complete` again

Shared helpers in `shared.ts`: `countConsecutiveNags()`, `stripNagMessages()`, `RECENTLY_COMPLETED` map. Nag responses use SSE buffer with `Content-Length` + `Connection: close` (not chunked) for VS compatibility.
| `3` | Switch to PROXY mode |
| `r` | Restart proxy (picks up code changes) |
| `e` | Toggle recording |
| `d` | Toggle debug entries (noisy handler logs, VS/GHCP/telemetry traffic) |
| `m` | Toggle model list overlay |
| `s` | Stop proxy |

## License

MIT
