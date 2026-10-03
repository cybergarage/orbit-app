# Prototype verification — 2026-10-03

Verified on `mac-mini-m4.local` only: Apple M4 / arm64 / 24 GiB, macOS 27.0.1 (26A434), Node v26.5.0, npm 11.17.0, Homebrew Git 2.55.0, Electron 44.5.1, React 19.2.8, TypeScript 5.9.3. Docker Desktop 4.55.0 (213807), engine 29.1.3; native Ollama 0.34.4. Worker Node v22.23.3. The main M6 was not used. No Xcode license was accepted.

## Real local checks

- Lint/typecheck and 11 unit/policy tests pass. Cases include path traversal, independent projects, concurrent durable writes, restart interruption, single admission, duplicate request IDs, setup/cleanup cancellation, stale approval expiry, gateway route/model/context limits, durable schedules, and conservative search syntax denial.
- Two Electron UI tests pass: project/session creation, renderer Node absence and sandbox/context isolation, narrow IPC rejection, repeated submission, cancellation, connection refresh, saved history after restart. The actual local Docker/Ollama interaction is separate from CI's basic UI test. The ephemeral Linux CI UI process uses --no-sandbox for runner compatibility, so CI does not validate Chromium OS sandbox enforcement. Local M4 tests use the normal sandboxed launch.
- Native `gemma4:12b` (Q4_K_M, digest `4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c`) read a harmless generated sum/test fixture, requested an edit, applied `a - b` -> `a + b` after approval, requested Bash `node test.cjs`, and obtained `fixture tests passed` inside the constrained container. No model was downloaded; no cloud model was used.
- A second turn reopened the same Orbit SessionRepository transcript/journal after supervisor restart. The native model correctly referenced `fixture tests passed` from the preceding turn without redoing the edit.
- Basic container checks verified read-only root, no mounted Docker socket or host SSH path, and failure to connect outside the network-disabled worker. These are targeted checks, not a kernel-security proof.
- A deliberately left-over detached container bearing the project's ownership label was recovered from persisted identity and removed at supervisor restart before new work. Real hard-kill-during-tool recovery and abrupt machine power loss remain untested; interrupted records are not replayed automatically.
- Unsigned `release/Orbit App-darwin-arm64/Orbit App.app` was built and launched using its packaged executable; its standalone window loaded successfully.

## Independent review

A separate read-only agent reviewed renderer/IPC, model gateway, container mounts, approval/cancellation and restart/schedule paths. Findings about delayed cancellation, orphan identity, concurrent recovery, cleanup admission, unhandled stop failures and RPC bounds were fixed. Search mitigation was narrowed after review to reject recursive/expanding syntax, rather than claim a depth check bounded total expansion. No earlier lifecycle finding remains outstanding in the final reviewed source. Reviewer checks are source review, not runtime verification.

## Remaining risks and exclusions

Schedules run only while the app is open. Daily schedules mean every 24 hours, not a timezone-aware calendar recurrence. Claimed occurrences may be skipped on a crash; they are never intentionally replayed to guarantee delivery. Background execution, power-on wakeups and full abrupt-power-loss durability are not implemented or verified.

Per-file 64 MiB limits plus a 256 MiB/10,000-entry polling watchdog are not a hard disk quota. Fast many-file writes may affect host free space before cancellation. Approved Bash can alter the same project's mounted core records; journals are not a tamper-proof boundary against its worker. Process/container limits constrain impact but do not guarantee no host impact.

`npm audit` reports zero app dependency findings. The fixed Orbit 0.8.1 worker dependency chain is `fast-glob@3.3.3` -> `micromatch@4.0.8` -> `braces@3.0.3`. Official [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high, updated 2026-10-02) affects <=3.0.3, with no first patched version. npm's latest versions of all three match this chain, so a compatible patched override is unavailable; no blind force update was used.

Model-generated `glob.pattern` and `grep.glob` reach fast-glob/micromatch/braces, so the dependency is reachable. The worker's operation policy rejects long/wide patterns and all brace, parentheses/extglob, bracket/character-class and backslash syntax before the built-in tool executes. Common `**/*.ts` and `main?.ts` remain supported. This deliberately narrows the prototype's search behavior and is a mitigation, not an upstream fix. A separately approved Bash script can import the vulnerable package directly and crash or exhaust its worker; network/host credential isolation and finite run/CPU/RAM limits remain the containment, with the disk caveat above. A general adversarial stress test of every parser surface is not claimed.

Signing, notarization, public releases, cloud fallback, arbitrary host folder mounts, background daemon, recursive artifact previews and multiple simultaneous workers are excluded from this slice.
