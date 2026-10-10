# CLI adapter module split

The user approved separating CodeBuddy and Claude into their own files, retaining shared subprocess mechanics. This refactor preserves the configured models, CLI argument order, authentication/version gates, event limits, error classification, streaming, usage calculation and cancellation behavior.

`codebuddy.ts` owns CodeBuddy health, Agent flags and its denied-tool catalog. `claude.ts` owns Claude subscription health, safe mode, policy/version preflight and initialization-auth validation. `cli-stream.ts` holds their shared print protocol and accepts internal callbacks for provider-specific checks. `subprocess.ts` retains transport and CLI utility functions. `index.ts` dispatches directly to the separate adapters; the CodeBuddy helper and tests use the relocated exports.

Implementation and verification: move the existing logic mechanically, update imports/dispatch, format the source, run all existing protocol regressions and TypeScript checks, then reload the owned local gateway and run read-only provider diagnostics. No new CLI feature, quota policy, account setting or client API is introduced. This workspace has no Git repository.
