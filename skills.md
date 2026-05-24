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
