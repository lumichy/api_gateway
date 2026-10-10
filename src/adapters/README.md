# Subscription adapters

Real providers default to disabled. Both `enabled:true` and `billingVerified:true` are required. The latter is the operator's explicit assertion that the configured account, credential and invocation use the intended subscription. It does not verify account eligibility or guarantee unlimited usage. Offline fixtures verify transport; separately authorized live checks are recorded in docs/verification.md.

`createProvider(config)` exports the shared Provider interface from `index.ts`.

Source layout:

- `codebuddy.ts`: CodeBuddy health, text Agent, denied tool catalog and invocation settings.
- `claude.ts`: Claude subscription health, safe-mode settings, version and initialization-auth checks. Managed-policy checks remain in `claude-policy.ts`.
- `cli-stream.ts`: Shared print/stream-json arguments, bounded event parsing, tool rejection, terminal consistency and usage conversion. Provider-specific preflight and initialization checks are supplied by the adapter.
- `subprocess.ts`: Shared process spawning, line limits, cancellation, temporary-directory cleanup, executable bootstrap validation and CLI helpers. It does not dispatch Claude or CodeBuddy requests.

`index.ts` dispatches each provider to its own module. The CodeBuddy setup/login helper also imports its Agent flags from `codebuddy.ts`.

Configuration:

```ts
{
 id: string,
 type: 'ark' | 'codex' | 'claude' | 'codebuddy' | 'antigravity' | 'demo',
 models: string[],
 enabled?: boolean, priority?: number, maxConcurrency?: number,
 billingVerified?: boolean,
 apiKeyEnv?: string, baseUrl?: string,
 command?: string, args?: string[],
 mode?: 'app-server' | 'responses' | 'exec', tokenEnv?: string,
 demo?: { remaining?: number | null, fail?: string, text?: string }
}
```

Only environment-variable names belong in configuration; credential values do not. CLI command is a fixed executable path. Args, when present, must contain exactly one absolute .js/.mjs/.cjs entrypoint (CodeBuddy also accepts the official extensionless bin/codebuddy entrypoint) and command must be node.exe (or node). Every health/invoke/quota subprocess validates this before spawning; CLI flags, positional prompts and relative bootstrap paths are rejected. Native Windows executables or node.exe are supported; shell execution and .cmd shell shims are not used.

## Implemented paths

| Path | Enable conditions | Request semantics | Quota |
| --- | --- | --- | --- |
| Demo | Enabled by default; no account | Local configured response | Manual remaining requests, null if omitted |
| Ark | Coding Plan enabled, dedicated key in apiKeyEnv (default ARK_CODING_API_KEY), explicit billing verification | Structured messages sent to dedicated Chat endpoint | Unknown: no verified quota query endpoint |
| Claude | Official CLI with documented flags, subscription login, verified billing for print mode | One user message, optionally one leading system message; history/developer rejected | Unknown |
| CodeBuddy | Official CLI, supported no-tools flags, subscription login and verified billing | One user with optional leading system; history/developer rejected | Unknown |
| Codex CLI exec | mode:exec, native CLI 0.157.1, ChatGPT account login, verified billing | One user and optional leading system; completed text emitted after successful process exit | Official app-server percentage windows |
| Codex Responses | mode:responses, tokenEnv naming app-authorized SIWC OAuth access token, eligible plan, authorized inference scope, verified subscription billing | One optional leading system becomes instructions; developer/user/assistant history stays structured | Unknown; never substitutes Codex CLI bucket |
| Codex app-server | Default mode, official Codex CLI subscription login | Quota read only; inference unavailable | Official percent windows when returned |

Ark is pinned to https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions. Any different baseUrl is rejected, including the generic /api/v3 billed route. Redirects are rejected. Use the dedicated Coding Plan credential and an account-supported model. [Official Coding Plan documentation](https://docs.volcengine.com/docs/ark/coding-plan-personal-get-started?lang=zh).

Claude Code 2.1.296 launches in a new empty temporary directory with --safe-mode (retains subscription OAuth), --tools "", --strict-mcp-config with empty MCP servers, disabled hooks/slash commands/browser, no permission prompts and no session persistence. API credential and CLAUDE_CODE environment overrides are removed. Auth status must report claude.ai, firstParty and Pro/Max; init apiKeySource must be exactly none. System/registry managed policies and remote-settings caches cause a fail-closed refusal before CLI startup because managed hooks survive safe mode. User text is stdin and optional system is a separate argv value. Unexpected tool calls, inconsistent results or unsuccessful child exit are rejected. Confirm Extra Usage is disabled before enabling. [Official CLI reference](https://code.claude.com/docs/en/cli-reference).

SIWC uses only https://api.openai.com/v1/responses, with store:false, stream:true, tools:[], and tool_choice:none. Obtain an access token through this application's separately authorized open-source SIWC flow; do not copy another application's tokens or use an API key (sk- credentials are rejected). Identity-only sign-in is insufficient. Token refresh/registration are outside the adapter and must be managed by the operator; rotate the named environment value when expired. Explicit billing verification is mandatory because the adapter cannot inspect opaque OAuth authorization. Model availability must be checked for the signed-in account. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Codex quota runs only initialize, initialized and account/rateLimits/read RPCs, rejecting server-initiated requests. It creates no inference thread and consumes no reset credits. Its pool is codex-app-server, not SIWC Responses. Native app-server inference remains unavailable: read-only sandbox policy alone does not disable shell/read tools, and this adapter has no verified all-tools-disabled app-server inference configuration. CLI exec uses a separate verified configuration. [Official app-server protocol](https://developers.openai.com/codex/app-server).

## CodeBuddy and remaining unavailable paths

CodeBuddy uses its official print CLI in an empty temporary directory, with --tools "" to disable built-ins, --strict-mcp-config and an empty MCP configuration to exclude Plugin MCP and user/project/local MCP sources, --setting-sources "" and --settings '{"disableAllHooks":true}', and no session persistence. It does not submit HTTP runs, whose per-run all-tools-disabled control was not verified. User text is stdin and the optional leading system instruction uses --system-prompt. Health checks executable version only; operator verification and inference still determine authentication/coverage. No permission-bypass flag is used. [Official CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference), [official hook settings](https://www.codebuddy.cn/docs/cli/settings).

Antigravity uses the official native CLI's cached Google account and stream-json protocol. Versions 1.3.1 and 1.3.2 are explicitly verified and allowed; unverified upgrades are refused. Health reports the installed accepted version. Each request creates a uniquely named Markdown Agent with tools/MCP/skills/plugins empty, an isolated working directory, literal optional system instructions, and one stdin user event. No continuation or permission bypass is enabled. The initialization tools array advertises the global catalog; real empty-tools/read-tool control requests verified that it does not describe the selected Agent's permissions. The parser checks Agent/model/cwd/permission, rejects actual tool/subagent events, requires a consistent single-turn SUCCESS result and successful process exit, and emits incremental text plus optional valid usage.

Before startup the adapter checks account-default billing and disabled extra credits, rejects global instructions/MCP/plugins, and requires explicit approval for global lifecycle hooks through `approvedHooksSha256`. The digest pins the complete hook configuration; any change requires renewed approval. It never copies cached tokens or modifies the global profile. Commercial Google API credential environment variables are removed from the child process. Official quota remains unknown; quota/rate/auth errors use existing gateway fallback and cooldown. Native cancellation was tested on Windows; POSIX CLI deployment and SIGTERM-resistant subprocesses have not been validated.

[Official headless documentation](https://antigravity.google/docs/cli/headless/), [Agent definitions](https://antigravity.google/docs/subagents/), [verification evidence](../../docs/verification.md).

These unavailable states cannot be bypassed with billingVerified. Health is a diagnostic of configured credentials/CLI login, not proof of current quota, model access or billing coverage. Unknown quota remains unknown.

## Transport verification

Node 24 tests use local HTTP/SSE and executable fixtures. They cover CRLF and fragmented UTF-8, optional usage, terminal markers/truncation, HTTP authentication/quota/rate-limit classification, retry timestamps, CLI structured input/flags, child cancellation, HTTP body cancellation, SIWC role conversion and quota provenance. No test contacts a subscription account.

## Codex exec isolation

CLI 0.157.1 uses exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --json --strict-config with read-only sandbox and fixed feature overrides disabling all model tools, skills, hooks, plugins and external integrations. Local Responses request capture verified tools:[] and no user skill or AGENTS instructions. A private model_instructions_file carries the optional system message; developer_instructions is cleared. User input is literal stdin. OPENAI/CODEX API credentials and endpoint overrides are removed; forced_login_method=chatgpt and model_provider=openai prevent API login/provider substitution.

The parser requires one thread, one turn, one completed assistant response and a successful terminal event/process exit. Only the exact known pre-turn code-mode-disabled notice is accepted; tool/unexpected events, truncation, duplicate terminal events and invalid usage fail closed. Text is emitted after completion, so SSE is buffered. Native cancellation and temporary-directory deletion are verified on Windows; POSIX SIGTERM-resistant subprocesses remain unvalidated. Version mismatch refuses inference.
