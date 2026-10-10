# Antigravity CLI Implementation Plan

Continue the user-approved official CLI gateway design. User explicitly requested integration like CodeBuddy on 2026-10-07. No Git repository exists in this workspace.

**Architecture:** A fresh private working directory and uniquely named Markdown Agent per request, with empty tools/MCP/skills/plugins and literal system instructions. User text travels as a single stdin NDJSON message. Use cached official Google account; reject commercial model providers and extra-credit mode. Pin CLI 1.3.1, whose Agent behavior was verified with a real empty-tools/read-tool control pair. Initialization lists the global catalog even when the selected Agent has no tools, so validate selected Agent/model/cwd/permission and reject actual tool/subagent steps instead of rejecting that catalog.

**Tech stack:** Native Node 24 TypeScript, existing bounded subprocess reader and scheduler.

- [x] Confirm real custom system instructions and empty-tools vs view_file behavior in isolated diagnostic directories.
- [x] Write failing Antigravity protocol and subprocess fixtures: streaming, result reconciliation, errors, role preservation, malformed/out-of-order events, unexpected tools, cancellation and billing guards.
- [x] Add `src/adapters/antigravity.ts`, register factory capabilities, reuse cancellation/cleanup; guard unsafe global hooks/MCP/rules where they cannot be disabled per process. Quota stays unknown.
- [x] Run focused/full tests, typecheck, source formatting and independent review. 112 tests pass; review global-rule finding fixed. Windows cancellation verified; POSIX SIGTERM escalation remains a shared limitation.
- [x] Validate real gateway ordinary/SSE calls, register verified models at priority20, start gateway, verify fallback and zero leases. Update docs with actual evidence and limits.

User chose to disable the installed `orca-status` lifecycle hooks. Original configuration backed up in ignored data directory; only enabled:false was added to that hook. Both Gemini aliases enabled and verified through real HTTP. Production SSE and isolated simulated Ark/CodeBuddy zero-quota fallback succeeded; leases0. Gateway PID23636. CLI version1.3.1 was confirmed before final enable. Exact official quota remains unknown.
