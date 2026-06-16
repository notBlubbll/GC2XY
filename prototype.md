# Prototype Analysis

## Chat Completions

### Traffic Source
Visual Studio 18.8.0-insiders (`editor-version: VS/VisualStudio.18.Preview/18.8.11904.113`), Copilot Free tier (`free_limited_copilot`), user `notBlubbll`.

### Auth & Feature Discovery

| # | Method | Host | Endpoint | Status | Purpose |
|---|--------|------|----------|--------|---------|
| 1,3 | GET | `api.github.com` | `/copilot_internal/content_exclusion` | 404 | Content exclusion not available (free tier) |
| 4,6,8 | GET | `telemetry.individual.githubcopilot.com` | `/telemetry` | 200 | Flight flags & feature config |
| 9 | GET | `api.github.com` | `/copilot_internal/user` | 200 | User info + quota |

### Model Discovery (3 endpoints queried)

| # | Host | Response |
|---|------|----------|
| 2 | `copilot-proxy.githubusercontent.com` | NES-only models (7): nes-callisto variants, instant-apply |
| 5 | `api.individual.githubcopilot.com` | Full model list (claude-fable-5, claude-opus-4.7, etc.) |
| 7 | `copilot-proxy.githubusercontent.com` | Same NES-only models |

### Completions — Two Different APIs

VS uses both the newer `/chat/completions` (NES) and the legacy `/v1/engines/{model}/completions` (suffix-based). The legacy API uses `prompt`+`suffix` instead of `messages`.

| # | Endpoint | Engine | Type | Notes |
|---|----------|--------|------|-------|
| 10 | `/chat/completions` | `copilot-nes-oct` | NES Ghost Text (inline edit) | Predicted `var x = 0;` from `var x =` |
| 12 | `/v1/engines/gpt-41-copilot/completions` | `gpt-41-copilot` | Legacy completions (suffix) | Generated `function setup() { createCanvas(400, 400); }` |
| 13 | `/v1/engines/gpt-41-copilot/completions` | `gpt-41-copilot` | Speculative (`x-copilot-speculative: true`) | Empty — no speculation available |
| 14 | `/v1/engines/gpt-41-copilot/completions` | `gpt-41-copilot` | Multi-choice (`n:3`, temp=0.2) | 3 completions requested, 2 came back identical |
| 15 | `/chat/completions` | `gpt-41-copilot` | Chat API (NES) | Final edit: `\tcreateCanvas(400, 400);\n}` |

### Legacy Completion Request Format

```json
{
  "prompt": "/* Path: TextFile1.css */\nvar x = 0;\n\n",
  "suffix": "",
  "max_tokens": 500,
  "temperature": 0,
  "top_p": 1,
  "n": 1,
  "stop": ["\n\n\n", "\n```"],
  "stream": true,
  "extra": {
    "language": "css",
    "next_indent": 0,
    "trim_by_indentation": true,
    "prompt_tokens": 14,
    "suffix_tokens": 0
  },
  "code_annotations": false
}
```

### NES Chat Completion Request Format

```json
{
  "messages": [
    {
      "role": "system",
      "content": "Predict the next code edit based on user context..."
    },
    {
      "role": "user",
      "content": "...recently_viewed_code_snippets...current_file_content...edit_diff_history...code_to_edit with <|cursor|>..."
    }
  ],
  "model": "copilot-nes-oct",
  "temperature": 0,
  "top_p": 1,
  "stream": true,
  "prediction": { "type": "content", "content": "var x =" },
  "n": 1
}
```

### SSE Response Format

Both APIs return `text/event-stream`. Legacy completions use `choices[].text`, chat completions use `choices[].delta.content`.

**Legacy completion stream:**
```
data: {"choices":[{"index":0,"finish_reason":null}]}
data: {"choices":[{"text":"function","index":0,"finish_reason":null}]}
...
data: {"choices":[{"text":"}\n","index":0,"finish_reason":"stop"}]}
```

**Chat completion stream:**
```
data: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"var"},"index":0,"finish_reason":null}]}
...
data: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

### Key Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `x-copilot-speculative` | `true`/`false` | Pre-fetch speculation flag |
| `x-copilot-async` | `true` | Async completion |
| `openai-intent` | `copilot-ghost` / `conversation-other` | Ghost text vs chat |
| `x-initiator` | `agent` | Agent-initiated request |
| `x-interaction-type` | `conversation-other` | Interaction classification |
| `prediction` | `{"type":"content","content":"..."}` | Speculative prediction hint |

### Quota

- **Chat**: 198/200 remaining (token-based billing)
- **Completions**: 2000/2000 remaining
- **Premium interactions**: 0/0 (not available on free tier)
- **Reset date**: 2026-07-01

### Observations

- Two completion APIs coexist: `/chat/completions` for NES agent edits, `/v1/engines/{model}/completions` for legacy suffix-based ghost text
- Speculative completions return empty when there's nothing to pre-fetch
- Multi-choice (`n:3`) with low temperature (0.2) on short context produces identical alternatives
- Free tier has no content exclusion (404)
- Token-based billing tracks prompt+completion tokens separately
