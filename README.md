# Orbit App

Private Electron prototype for local projects and sessions. The trusted desktop supervisor uses native host Ollama; the complete Orbit agent and its coding tools execute inside one network-disabled container. No cloud model fallback.

## Run on the secondary M4

```sh
cd ~/Src/orbit-app
npm ci
npm run worker:build
npm run dev
```

Docker Desktop and Ollama must already be running. Select an installed tool-capable model; the verified model is `gemma4:12b`. No model is pulled automatically. Create a project and session, submit a task, review each write/command, inspect progress and refresh artifacts. Project workspaces are app-managed rather than arbitrary host folders.

```sh
npm run package
open "release/Orbit App-darwin-arm64/Orbit App.app"
```

The unsigned local `.app` still needs the locally built worker image and Docker/Ollama. Packaging does not include Docker or models. This prototype does not sign, notarize, publish, install a daemon, or change Ollama's binding.

## State and schedules

State is under Electron's `app.getPath('userData')` (`~/Library/Application Support/orbit-app` in development). The manifest is atomically replaced; each project has separate `workspace` and Orbit `core` stores. Core transcripts and execution journals use Orbit's own SessionRepository and durable recorder. The host manifest is a UI mirror, not a replacement model loop. A session interrupted by a crash is marked interrupted; do not automatically replay it. Inspect the history and create a new session if Orbit refuses recovery.

One-time, hourly and every-24-hour schedules persist. **They run only while this app is open.** After shutdown, at most one missed occurrence per schedule is considered, without replaying every missed run. The next occurrence is claimed durably before submission; a crash may skip a claimed occurrence rather than replay a potentially completed side effect. Offline failures appear in history. Tool approvals still require the open UI. The Mac need not remain on; no background daemon is included or verified.

## Boundaries and limits

- Renderer: no Node integration; context isolation, sandbox, restrictive CSP; main-frame/sender-validated narrow IPC. External navigation and windows are denied.
- Worker: no network, read-only root, all Linux capabilities dropped, no-new-privileges, non-root image user, 2 CPUs / 2 GiB / 128 PIDs. Only this project's workspace and core state are mounted. No host home, credentials or Docker socket is mounted.
- Model gateway: fixed host loopback endpoint, selected installed model, only chat/show/ps, <=32 RPC requests / <=2 concurrent / <=9 chat calls, fixed 8K context and 1024 output tokens. No arbitrary URL, pulls or provider credentials.
- Orbit owns the tool loop, approvals, budgets and session journal. Tool writes/commands require current owner approval; cancellation/expiry prevents stale approval. Run limit: 8 tool rounds / 24 requests / 210 seconds, plus host termination at 240 seconds.
- Container identity is saved before start. Restart validates its ownership label and removes a surviving worker before admitting new work. Docker failures retain recovery-blocked identity. No automatic replay of interrupted operations.
- 64 MiB per-file limit and a 256 MiB / 10,000-entry project watchdog are **not a hard disk quota**. Rapid many-file writes can consume space before the watchdog stops the container. A Docker VM is not a proof of isolation against kernel vulnerabilities. Bash can modify the project's mounted core records; those records are not tamper-proof against that project's worker.
- Artifact listing currently shows top-level regular files only. There is no automatic preview/execution or arbitrary host-file access.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run worker:build
npm run test:live
npx tsx scripts/lifecycle.ts
```

Unit tests cover path validation, persistence, admission, duplicate requests, cancellation during setup/cleanup, gateway clamps, expired approvals, and schedules. Local Electron tests cover creation, repeated submit/cancel, reconnect, restart and renderer settings. `test:live` performs bounded native Ollama inference and auto-approves only a generated harmless fixture in a temporary project, then verifies its test execution and basic isolation. CI skips the native model test and live UI interaction; its ephemeral Linux UI process uses --no-sandbox and is not evidence of Chromium OS sandbox enforcement; it runs unit tests, basic Electron lifecycle and an offline worker import/shell check.

Orbit is pinned to npm `@cybergarage/orbit@0.8.1` and its lockfile integrity. Upstream main inspected: `56b1bea2d9f7b60266c03e2fece0bad579230290`; the source reference checkout is not altered. Published package behavior is verified directly rather than assumed identical to moving main. The pinned Orbit worker dependency currently reports an unpatched braces/micromatch/fast-glob stack-exhaustion advisory; process/container budgets reduce impact but do not fix it. Worker policy rejects glob/grep patterns longer than 2048 characters, arrays over 16 patterns, or brace, parentheses/extglob, bracket/character-class and backslash syntax before tool execution. This deliberately narrows accepted tool inputs, does not patch braces, and does not prevent an approved Bash script from importing the vulnerable dependency directly. App dependencies audit clean. See `docs/verification.md` for actual evidence and remaining limitations.
