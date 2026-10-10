# Antigravity CLI integration

Continue the approved subscription gateway architecture: official native CLI cached Google account, single user and optional system supplied in a private empty-tool agent; isolated per-request directory; no permission bypass; no custom API-key billing route; no continuation. Pin the validated CLI version, require initialization model/agent/tools verification, reject any tool step before text, parse complete NDJSON terminal SUCCESS and optional usage, cancel and cleanup using existing subprocess bounds. Quota remains unknown until an official stable machine interface is validated. Priority after Ark and CodeBuddy.

1. Verify installed models and empty-agent initialization using read-only commands and one minimal live request.
2. Write failing fixtures/tests for protocol, tool rejection, model mismatch, auth/quota/rate errors, cancellation and user/system preservation.
3. Implement focused src/adapters/antigravity.ts and factory integration, format and run full tests/typecheck.
4. Independent code review required by requesting-code-review skill. Enable only if live constraints are verified, then restart owned gateway and test pinned SSE + fallback. Record limits and results.

## Discovery outcome (2026-10-06)

Official CLI 1.3.0 account model discovery succeeded. Empty-input NDJSON initialization with both documented Agent layouts, including a temporary Git workspace, still advertised built-in file, shell, browser and MCP tools despite `tools: []`. No inference was submitted. Steps 2–4 have not started: the prerequisite for the approved text-only adapter remains unverified. The production configuration and running gateway are unchanged. Detailed evidence is recorded in `docs/verification.md`.
