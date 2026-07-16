# Symphony

Symphony is a standalone TypeScript service that polls Linear, assigns each eligible issue a durable workspace, and drives a local Codex app-server session for that workspace.

## Trust Model

This implementation is intended for a trusted developer host. It executes repository-owned workspace hooks and launches the configured Codex command inside per-issue workspace directories. It does not expose a network control plane, persist API keys, or write issue state itself. Keep `WORKFLOW.md` and environment secrets under the same change-control policy as the repositories it operates.

## Setup

```powershell
Copy-Item WORKFLOW.example.md WORKFLOW.md
$env:LINEAR_API_KEY = "lin_api_..."
npm install
npm run check
npm start
```

The service discovers `WORKFLOW.md` in its working directory by default. Use `npm start -- --workflow C:\path\to\WORKFLOW.md` to select another workflow. `npm run once` executes one reconciliation and dispatch cycle without keeping the scheduler alive.

## Implemented Contract

- YAML-front-matter workflow loading with strict Liquid rendering and `$VAR` resolution only where the workflow explicitly requests it.
- Dynamic workflow reload that retains the last valid configuration after an invalid edit.
- Linear GraphQL candidate, state-refresh, and startup terminal-cleanup clients.
- Deterministic, sanitized per-issue workspaces with lifecycle hooks and containment checks.
- A single-authority orchestrator with priority ordering, label/blocker eligibility, global and per-state concurrency, reconciliation, stall cancellation, continuation retries, and exponential failure backoff.
- Local Codex app-server JSON-RPC over JSONL: `initialize`, `thread/start`, `turn/start`, streamed event forwarding, timeout handling, and in-worker continuation turns.
- Structured JSON logs and an in-memory runtime snapshot method for an optional status surface.

## Validation

```powershell
npm run check
```

The automated suite covers workflow parsing and reload behavior, workspace key/path rules, dispatch eligibility, concurrency, continuation retries, terminal reconciliation, and retry backoff. A real Linear token and a locally authenticated `codex app-server` are required for live integration.
