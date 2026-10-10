# Codex CLI and Claude subscription implementation plan

**Goal:** Add both official CLIs to the approved subscription gateway design, using cached account login and no executable model tools.

**Architecture:** Keep one OpenAI-compatible frontend and existing scheduler. Claude uses account-compatible safe mode; Codex uses exec JSONL if its model-visible tool catalog can be proven empty. Keep the existing quota-only app-server and SIWC modes distinct. Never copy credentials or silently change account billing.

**Tech stack:** Node 24, TypeScript, native child processes, node:test.

- [x] Probe installed CLI isolation: Claude 2.1.296 safe mode; Codex 0.157.1 ignored config/rules and disabled features. Local request capture proved tools:[] without changing model metadata.
- [x] Write failing fixture tests for subscription authentication, separate system input, empty tool catalog, lifecycle/terminal validation, cancellation, quota/auth errors, and unsupported roles; confirm intended failures before implementation.
- [x] Replace Claude bare mode with safe mode, explicit tools/MCP/hooks disabling, sanitized child environment, and subscription auth validation. Preserve CodeBuddy behavior. Harden the shared stream parser and refuse managed policy sources.
- [x] Implement `src/adapters/codex-exec.ts` and fixture. Fixed flags, separate developer instruction override, bounded events, reject tool items, require one completed response and successful child exit. Add `mode: exec`, leaving the older unverified app-server inference blocked.
- [x] Run meaningful regression tests, typecheck and source formatting. Obtain code review and resolve findings. Evidence: 143 full tests, 30 focused tests, typecheck/format passed; cancellation and strict auth-source fixes reviewed.
- [x] Verify logged-in account status without tokens. Run minimal live requests only on subscription paths with billing safeguards confirmed; verify ordinary/SSE gateway calls, simulated quota fallback and released reservations.
- [x] Enable only verified providers in private local configuration, restart the owned gateway process, update examples and docs with actual results and remaining limits.

Codex live HTTP/SSE, simulated zero-quota fallback, official quota windows and production restart are complete. User confirmed Claude Extra Usage disabled; Claude live adapter, HTTP/SSE, simulated zero-quota fallback and actual production endpoint all returned OK. Both providers are enabled. Latest regression: 146 tests passed plus typecheck/format. Details: docs/verification.md, 2026-10-10 section.

The original design and this CLI direction are already approved by the user. No Git repository exists; implementation stays in this workspace. Any CLI that cannot satisfy the empty-tools gate stays unavailable with the exact limitation recorded.
