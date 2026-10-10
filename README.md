# Subscription AI Gateway (subscription-ai-gateway)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## What this project does

A **personal AI gateway that runs locally**. It combines multiple AI providers, using subscription accounts or API services, behind one OpenAI-compatible endpoint: clients always connect to `http://127.0.0.1:8787/v1`. With `auto`, the gateway selects a provider based on request capabilities, remaining quota and availability, and attempts fallback on quota exhaustion, rate limits, authentication failures or temporary errors.

Core features:

- **One endpoint**: standard `/v1/chat/completions`, compatible with OpenAI client SDKs, with streaming SSE support.
- **Automatic routing**: remaining-quota scoring, cooldowns and concurrency reservations. Non-streaming requests can fall back before completion depending on the error type; streaming requests never switch providers after emitting any chunk.
- **Quota telemetry**: official sources are preferred. Unavailable quota is marked `unknown`; balances are never invented.
- **Capability-aware routing**: compatible APIs forward tools, multimodal messages and extension parameters. Unsupported CLI requests return 400; `auto` selects only providers that support the request.

This is a **local service for one user**: it listens only on loopback addresses, all clients share one key and the same quota, and it provides no conversation memory or sticky routing. It is not suitable for shared or multi-tenant deployment.

Node.js ≥ 24 runs the TypeScript source directly. There are **no third-party runtime dependencies**: the gateway uses built-in modules such as `node:http`, `node:sqlite` and `node:child_process`. No build step is required.

## Installation

```powershell
git clone <repository-url> api_gateway
cd api_gateway
```

Node.js 24 or later is required. No `npm install` is needed to run the gateway. During development, `npm install` installs TypeScript and Prettier for type checking and formatting.

Check the environment:

```powershell
node --version          # Requires v24+
node scripts/doctor.ts --config config.example.json
```

`doctor` performs pre-start diagnostics: it validates configuration and checks enabled providers' executables, credential environment variables and some CLI login states. It sends no inference requests and displays no keys. It does not guarantee upstream connectivity, model access or remaining quota.

## Configuration

### 1. Prepare keys

The gateway uses two separate keys, each at least 24 characters long:

- `GATEWAY_KEY`: client access to inference endpoints.
- `GATEWAY_ADMIN_KEY`: administrative access to status, manual quota entry and unblocking.

The two keys must differ; otherwise anyone with the inference key could access the administrative endpoints.

Configuration files contain **only environment variable names**. Actual keys always come from environment variables, so configuration files can be committed safely. Use a private environment file such as `.env.local`, which is excluded from Git:

```
GATEWAY_KEY=a-random-value-of-at-least-24-characters
GATEWAY_ADMIN_KEY=another-random-value-of-at-least-24-characters
```

### 2. Create a configuration file

Copy and edit the example:

```powershell
Copy-Item config.example.json config.local.json
```

Top-level fields:

| Field | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` | Only `127.0.0.1` or `::1` is allowed; other values prevent startup. |
| `port` | `8787` | 1–65535. |
| `statePath` | `data/gateway.sqlite` | SQLite state database; relative paths resolve against the configuration file's directory. |
| `gatewayKeyEnv` / `adminKeyEnv` | `GATEWAY_KEY` / `GATEWAY_ADMIN_KEY` | Environment variable names. |
| `timeoutMs` | `120000` | Total time budget per request, including all fallback attempts; 100–600000. |
| `quotaTtlMs` | `60000` | Quota snapshot freshness interval; 100–3600000. |
| `providers` | — | List of 1–32 providers. |

The current `config.example.json` contains models, enablement flags and executable paths copied from the local configuration. It is not a portable template with all providers disabled. When copying it to another machine, review paths, environment variables and enabled providers. Actual keys remain in the private environment file.

Fields shared by all providers:

| Field | Description |
| --- | --- |
| `id` | Unique lowercase identifier; also the routing alias prefix (`id/model`). |
| `type` | `openai-compatible` / `codex` / `claude` / `codebuddy` / `antigravity`. |
| `models` | List of 1–64 models. `openai-compatible` model names may contain `/`, such as `nvidia/model:free`; other types prohibit `/`. `auto` uses the first model in the list. |
| `enabled` + `billingVerified` | **Both must be `true` to enable the provider.** The latter records the operator's confirmation of the intended billing path: the intended subscription for a CLI, or the intended account's free quota or accepted API billing for an API. |
| `allowAuto` | Whether the provider participates in `auto` routing; see each provider type below. |
| `priority` | Lower values win ties; 0–10000, default 100. |
| `maxConcurrency` | Maximum concurrent requests for this provider; 1–32, default 1. |

Real providers are disabled by default in the implementation, but configuration can explicitly enable them. Before enabling a CLI, log in through the official client and verify model access and extra usage billing settings. For an API, configure a valid key and verify model access and billing before setting both flags.

Current local configuration on disk (2026-10-10):

| Provider | `enabled` | First model used by `auto` | `priority` |
| --- | --- | --- | --- |
| Ark | `true` | `deepseek-v4.1-flash` | 5 |
| Agnes | `true` | `agnes-3.0-flash` | 5 |
| OpenRouter | `true` | `nvidia/nemotron-3-ultra-550b-a55b:free` | 100 |
| CodeBuddy / Antigravity / Codex / Claude | `false` | Not eligible for routing | Per-provider configuration |

All 7 providers have `allowAuto: true` and `maxConcurrency: 3`; disabled providers remain ineligible. OpenCode Zen has been removed from the local configuration. `config.example.json` still reflects the previous synchronization, with OpenRouter disabled and `openrouter/free` as its first model. The configuration file specified at startup is authoritative.

### 3. Start the gateway

```powershell
node --env-file=.env.local src/main.ts --config config.local.json
```

The gateway listens at `http://127.0.0.1:<port>/v1`. Missing gateway keys, invalid configuration fields or malformed API endpoints prevent startup. Provider credentials, CLI login/version issues and model access problems may instead surface during health checks or actual requests.

**Restart the process after changing `config.local.json` or `.env.local`.** Configuration hot reload is not implemented. Let active requests finish, stop the old process, then run the startup command again. On-disk configuration may differ from the running configuration; use `GET /admin/status` and `GET /v1/models` to check what is actually enabled. Manual quota entry, quota refresh and clearing cooldowns take effect immediately through the admin endpoints without a restart.

### 4. Connect a client

Example using the OpenAI Python SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="YOUR_GATEWAY_KEY")
result = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Explain how the gateway's fallback works."}],
)
print(result.choices[0].message.content)
```

Supported `model` values:

| Value | Behavior |
| --- | --- |
| `auto` | Selects by quota, cooldown and priority, subject to `allowAuto`. |
| `id/model`, such as `claude/sonnet` | Pins the provider; failures are returned directly, with no fallback. |
| Anything else | 400. |

The `x-gateway-provider` / `x-gateway-model` response headers identify the actual provider and model. The response body's `model` preserves the alias supplied by the client, including `auto`. Errors with a known retry time include a `retry-after` header.

### How `auto` selects a provider

1. Consider only providers with `enabled`, `billingVerified` and `allowAuto` set to `true`. Use each provider's `models[0]`; do not randomly rotate through its model list.
2. Filter by request capabilities before health checks and quota queries. Requests with tools, multimodal content or generation parameters go only to compatible APIs. Selecting `auto` does not add these capabilities to CLIs.
3. Exclude candidates that fail health checks, are cooling down or have known zero quota. Attempt to query missing or expired non-manual quota. Failed queries remain unknown and are not treated as quota exhaustion.
4. Prefer fresh known quota over unknown quota. For multiple quota windows, use the lowest remaining proportion as the score; higher scores win. Break equal scores, or ties between unknown quotas, by ascending `priority`, then alphabetical provider ID.
5. Attempt concurrency and budget reservations in that order. If a provider is at capacity, try the next one. Attempt each provider at most once. Retryable errors allow fallback; invalid parameters or unsupported requests return immediately. Streaming cannot switch providers once output starts.

For the current on-disk configuration, OpenRouter ranks ahead of Agnes and Ark if it successfully reports fresh, nonzero free daily request quota, even with `priority: 100`, because their quotas are unknown. If all three quotas are unknown, the order is Agnes → Ark → OpenRouter: Agnes and Ark both have priority 5, so their IDs break the tie. Quota, cooldown, concurrency and request capabilities can change this order.

## Provider configuration

There are five provider types. CLI adapters (claude / codebuddy / antigravity / codex exec) share these constraints:

- **Single-turn requests**: one user message with an optional preceding system instruction. Multi-turn `auto` requests are filtered to providers supporting structured history (openai-compatible / codex responses). An explicit CLI alias rejects unsupported history without fallback.
- **Version compatibility**: Claude and Codex exec use verified pinned versions; Antigravity uses a verified version allowlist. CodeBuddy checks executable availability and validates the actual event protocol. Recheck compatibility after upgrades.
- **Argument allowlist**: `command` must be node.exe or a native executable; shells and `.cmd` files are prohibited. `args` may contain only one absolute JS entry path. Runtime flags, settings overrides and embedded prompts are rejected.
- **Runtime validation**: tool-disabling arguments, dedicated agents with no tools and event checks restrict CLI tools. Actual tool calls or initialization data violating the adapter contract cause rejection. Antigravity's global tool catalog does not represent the selected agent's tool permissions.

---

### openai-compatible — generic API integration

**Any HTTP service using a Bearer key and the OpenAI Chat Completions protocol can be added through configuration alone, with no code changes.**

```json
{
  "id": "ark",
  "type": "openai-compatible",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "apiKeyEnv": "ARK_CODING_API_KEY",
  "models": ["deepseek-v4.1-flash", "glm-5.3-flash", "doubao-seed-2.1-lite"],
  "quotaSource": "ark-cli",
  "allowAuto": true,
  "enabled": false,
  "billingVerified": false,
  "priority": 10,
  "maxConcurrency": 3
}
```

Key points:

- Set `baseUrl` to the **API base path**; the gateway appends `/chat/completions`. URLs are validated: only http/https, with no embedded credentials, query strings or fragments. Redirects are not followed.
- **Inference uses the same generic adapter** for Ark, OpenRouter, Agnes and similar services. Configuration supplies their endpoints and keys; no special inference type is selected by provider ID. Optional quota collectors have separate official-source requirements.
- Structured multi-turn history and system instructions are forwarded unchanged, without protocol translation.
- **`allowAuto` defaults to `false`**. Token-billed APIs can incur charges if selected by a fallback chain, so automatic routing requires an explicit `true`. Explicit aliases (`id/model`) are unaffected.

**Quota telemetry extensions.** Quota defaults to `unknown`, with routing then ordered by `priority`. Set the optional `quotaSource` to use official telemetry:

| `quotaSource` | Quota source | Additional requirements |
| --- | --- | --- |
| `"openrouter"` | Official key endpoint: daily request counts for free models, plus the API key's USD usage and spending limit. | `baseUrl` must be the official `https://openrouter.ai/api/v1`. USD data is neither wallet balance nor a substitute for remaining free requests. |
| `"ark-cli"` | Official arkcli: reported session / weekly / monthly percentage windows. | Install and log in to official arkcli; `quotaCommand` can specify a native executable. Separate control-plane credentials are required; an inference API key cannot replace them. |

Adding a new compatible API requires **JSON configuration, a key in an environment variable and both enablement flags**. A service supporting Chat Completions requires no new adapter code.

Agnes is included in the local and example configurations: model alias `agnes/agnes-3.0-flash`, base URL `https://apihub.agnes-ai.com/v1`, and key variable `AGNES_API_KEY`. It is enabled locally and has been verified with actual requests, with explicit `allowAuto: true` and `maxConcurrency: 3`. Quota collection is not integrated, so its quota is `unknown`. On a new installation, supply your own key and verify billing. See the [official Agnes documentation](https://www.agnes-ai.com/en/docs/agnes-30-flash) for the model and endpoint.

#### Chat Completions features

`openai-compatible` preserves request parameters and message JSON: `tools`, `tool_choice`, `parallel_tool_calls`, tool result messages, legacy `functions/function_call`, `response_format`, `temperature`, `top_p`, `stop`, `max_tokens/max_completion_tokens`, `n`, `logprobs`, `stream_options`, reasoning options and provider-specific fields. Content arrays containing images, audio or files are forwarded unchanged. Availability depends on the upstream model. The gateway does not execute tools or download media from messages.

Streaming and non-streaming responses preserve all choices, tool calls, reasoning content, refusals, audio, annotations, logprobs, usage details and extension fields. The returned `model` is the client's gateway alias; the actual provider and model appear in `x-gateway-provider` / `x-gateway-model`. Once any streaming chunk is emitted, providers are never switched, preventing mixed tool arguments or answers.

Example tool calling with the OpenAI Python client:

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=os.environ["GATEWAY_KEY"])
messages = [{"role": "user", "content": "What is the temperature in Tokyo now?"}]
tools = [{"type": "function", "function": {
    "name": "get_temperature", "description": "Get a city's temperature",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                   "required": ["city"]}
}}]
result = client.chat.completions.create(
    model="ark/deepseek-v4.1-flash", messages=messages,
    tools=tools, tool_choice="auto",
)
answer = result.choices[0].message
if answer.tool_calls:
    messages.append(answer.model_dump(exclude_none=True))
    for call in answer.tool_calls:
        # Mock result; real applications should validate the tool name/arguments
        # and execute their own tool.
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": '{"temperature": 20, "unit": "C"}'})
    final = client.chat.completions.create(
        model="ark/deepseek-v4.1-flash", messages=messages, tools=tools,
    )
    print(final.choices[0].message.content)
else:
    print(answer.content)
```

CLI and subscription Responses paths still support only their existing text semantics. Extension parameters return `unsupported` rather than being silently ignored. The compatible API's `allowAuto` default is unchanged; tool or multimodal requests using `auto` select only enabled compatible APIs that allow automatic routing. Limits remain 1 MiB per request, 16 MiB per response and 1 MiB per SSE frame.

### claude

The local official Claude Code CLI, pinned to **2.1.296**.

```json
{
  "id": "claude",
  "type": "claude",
  "models": ["sonnet"],
  "command": "claude",
  "enabled": false,
  "billingVerified": false,
  "priority": 20
}
```

- Each request starts in a new temporary directory, with `--safe-mode`, no tools or MCP, disabled hooks/slash commands/browser, and no saved sessions. `ANTHROPIC_*` / `CLAUDE_CODE_*` environment variables are stripped to use the subscription login instead of API billing.
- Health checks require a subscription login: `claude.ai`, firstParty and Pro/Max. System-level managed policies (managed settings / registry) cause rejection before invocation because managed hooks can bypass safe mode.
- Quota comes from official `rate_limit_event` windows, such as five hours or seven days, observed only in **actual request responses**. There is no separate read-only query; quota remains `unknown` until an event is observed.
- CLI 2.1.296's `unifiedWindows` has been verified with actual requests. It exposes utilization and reset times across multiple windows. Unreported windows remain unknown and are not converted into invented remaining request counts.

### codebuddy

The local official CodeBuddy CLI; log in using `scripts/login-codebuddy.ts`.

```json
{
  "id": "codebuddy",
  "type": "codebuddy",
  "models": ["REPLACE_WITH_ACCOUNT_MODEL"],
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/path/to/.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"],
  "enabled": false,
  "billingVerified": false
}
```

- `args` is one absolute JS entry path for node.exe; the official extensionless `bin/codebuddy` is also accepted. This CLI version's parser does not support wildcards, so the gateway disables approximately 60 built-in tools individually and creates a dedicated agent with no tools.
- If initialization events still report tools, the request is rejected. Runtime reports are checked rather than relying solely on arguments.
- Hooks are disabled, MCP configuration is empty, the temporary directory is isolated, and sessions are not saved.
- No official CLI account balance query has been verified. Quota remains `unknown`; `/cost` and model credit multipliers cannot replace account balance. Enter quota manually through `/admin/quota` if needed.

### antigravity

The local official agy CLI, supporting versions 1.3.1–1.3.3. Google login is cached by the official CLI; the gateway does not handle the credentials.

```json
{
  "id": "antigravity",
  "type": "antigravity",
  "models": ["gemini-3.8-flash-low"],
  "command": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
  "enabled": false,
  "billingVerified": false
}
```

- Each request creates a uniquely named agent with empty tools/MCP/skills/plugins and an isolated working directory. Commercial API credential environment variables are stripped from the child process to use the cached account.
- Before invocation, the `~/.gemini` profile is audited. Global instruction files, MCP, plugins or rules cause **immediate rejection if present**. Global hooks require the operator to approve the current configuration's SHA-256 digest through `approvedHooksSha256`; any change requires approval again. The gateway does not alter global user settings.
- Quota uses the official CLI's read-only `/usage` JSON, requiring 1.3.3. It reads five-hour and weekly percentage windows separately for Gemini and third-party Claude/GPT model groups, without additional model calls.

### codex

Three mutually exclusive modes:

| `mode` | Capability | Description |
| --- | --- | --- |
| `app-server` (default) | Read-only quota | Official RPC reads percentage windows. **Inference is unavailable** until a configuration with all tools disabled can be verified. |
| `responses` | Inference | ChatGPT SIWC access token (`tokenEnv`), structured multi-turn history and system instructions. `sk-` API keys are rejected. The operator obtains and rotates tokens; automatic refresh is not implemented. |
| `exec` | Inference | Official CLI **pinned to 0.157.1**, ChatGPT account login, read-only sandbox and explicitly disabled tools/skills/plugins/memory features. Single-turn requests. |

```json
{
  "id": "codex",
  "type": "codex",
  "mode": "exec",
  "models": ["gpt-6-sol"],
  "command": "codex",
  "enabled": false,
  "billingVerified": false
}
```

## Operations

Administrative endpoints all require the Admin Key:

| Endpoint | Description |
| --- | --- |
| `GET /admin/status` | Provider capabilities, quota snapshots, cooldown records and active leases. |
| `POST /admin/quota` | Enter quota manually; `pool` enables shared quota pools, and `resetAt` uses Unix milliseconds. |
| `POST /admin/quota/refresh` | Read-only quota collection with optional `provider` and `model`. By default, queries the first model of each enabled provider. No model calls; manual quota is not overwritten. |
| `POST /admin/unblock` | Clear the specified provider/model's snapshot and cooldown, then collect again. |

Automatic failure handling: quota exhaustion triggers a cooldown until the official reset time, or 60 seconds if unknown; rate limits follow `Retry-After`; authentication failures block the entire provider for 5 minutes. Only one recovery probe is allowed after cooldown expires. Concurrency leases left by a crashed process are cleaned up when they expire.

Read and refresh quota:

```powershell
npm run quota
node --env-file=.env.local scripts/quota.ts --provider ark
node --env-file=.env.local scripts/quota.ts --provider antigravity --model gemini-3.8-flash-low
```

In the output, `quota` is the current query result, `effectiveQuota` is the cache actually used for routing, and `saved` indicates whether a new non-unknown snapshot was saved. Manual quota takes precedence and is not overwritten by official refreshes. Official snapshots are cached for 60 seconds by default. Normal requests attempt refresh when quota is missing, unknown or expired, and briefly attempt another refresh after a successful call. Claude only reads events already produced by actual requests; refresh commands do not send an extra conversation to obtain quota. Reading the same official observation does not extend its freshness.

Health checks and quota queries have separate time limits: by default, up to 3 seconds and 10 seconds respectively during routing, and up to 1 second for a best-effort refresh after a call. The total request timeout still applies. Query failures do not block a healthy provider; the result reports an unknown source and reason. Historical quota or cooldown records for removed providers may remain in SQLite, but they are excluded from routing and `/v1/models`.

## Development and testing

```powershell
node --test tests/*.test.ts     # Local HTTP/SQLite/subprocess fixtures; no real accounts
npm run typecheck               # Run npm install first for development dependencies
npm run format:src
npm run format:check
```

Adding a standard compatible API provider requires configuration only. For other protocols, implement the `Provider` interface in `src/types.ts` and register the adapter in `src/adapters/index.ts`. Extend the HTTP layer and scheduler only for features outside the existing message or event contracts. See [src/adapters/README.md](src/adapters/README.md) for the detailed contract and `docs/code-walkthrough.md` for the code walkthrough.

## Current limitations

- **Endpoint coverage**: `/v1/chat/completions` and `/v1/models` are available. There are no public `/v1/responses`, Embeddings, standalone image generation, audio transcription or file management endpoints. Codex `mode: responses` is an internal subscription path, not a client-facing Responses API.
- **CLI capabilities**: Claude, CodeBuddy, Antigravity and Codex exec accept text requests with one user message and an optional preceding system instruction. Tools, multimodal content and generation parameters are unsupported. Explicit CLI requests return `unsupported`; `auto` filters by capabilities. Internal Codex Responses supports text multi-turn history but not these extension fields.
- **Compatible API support**: forwarding is implemented for tools, structured output, multimodal messages, reasoning parameters and response extensions. Availability depends on the upstream model. The gateway does not execute tools, download media or add missing capabilities to models.
- **Routing scope**: automatic routing uses only each provider's `models[0]`, without choosing other models within that provider. Explicit aliases do not fall back across providers. There is no sticky routing, so later `auto` requests may use a different model. Invalid parameters and unsupported requests do not trigger fallback, and providers cannot change after streaming begins.
- **Quota is not an exact live balance**: official snapshots have caching and collection delays; percentage windows are not remaining token or request counts. Ark requires additional control-plane login, Claude requires observed response events, and official balance collection is not implemented for CodeBuddy or Agnes. Unknown quota remains eligible. Concurrent token budgets are conservative estimates; actual consumption is settled against valid upstream usage. USD key usage is not account wallet balance.
- **Capacity and configuration changes**: request bodies are limited to 1 MiB, cumulative responses to 16 MiB and individual SSE frames to 1 MiB. `maxConcurrency` limits requests within this local gateway; it does not increase upstream quota or rate limits. Configuration and environment file changes require a restart.
- **Local service scope**: loopback only, with no multi-tenancy, user isolation or built-in conversation storage. `available`/`doctor` does not guarantee connectivity, quota, model access or billing; `billingVerified` is an operator declaration. CLI deployment on POSIX and cleanup of child processes that resist SIGTERM have not been verified.
- **Logging scope**: routine gateway status and error output does not record prompts, tokens, keys or raw upstream error bodies. Client-saved responses, independent CLI logs and manual verification reports in `.tools` have their own data retention scope.
