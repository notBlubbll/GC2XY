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
