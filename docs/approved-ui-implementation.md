# Approved desktop UI and persistence contracts

This implementation builds on `e87330e094f2a55bda172b78c808ce05b0da5658` and keeps the worker pinned to Orbit 0.8.1. It changes the Electron/React app; Orbit upstream and Nest are unchanged.

## Screens and interactions

The light theme uses locally stored Figma Dock SVGs. Home and New chat share a composer. Home/Scheduled/Settings navigation, project creation/editing, session rename/move, conversation model selection, and persistent Runtime status use actual application state. Connection details show Ollama, Docker daemon, worker image and the last check timestamp. No Figma example values are used as application data.

Session menus open through right-click or the ellipsis button. Outside pointer interaction is consumed and closes only the menu; ESC preserves the screen, selected conversation and timeline scroll. Rename remains available during recovery. Move is disabled in the UI and rejected by the host while running, admitting, awaiting approval/cleanup or recovery. There is no Dismiss button.

## History and directory preservation

The additive metadata migration retains existing project/session/event/schedule collections and core files. An existing state file is copied exclusively to `state.pre-approved-ui.json` before its first upgrade; this file is never overwritten. Core journals and transcripts are not physically moved or copied.

Each session records its original `storageProjectId` and host `workspace`. Membership moves retain both values, so future workers reopen the original Orbit core and the original directory mounted at `/workspace`. Linked future schedules follow membership, while past execution records retain historical project identity. Directory changes affect new conversations only. Future tasks receive current project guidance alongside an explicit instruction to follow workspace ORBIT.md / AGENTS.md guidance; this does not replace Orbit policy or instruction discovery.

Optional directories must already exist below the canonical user home or runtime `os.tmpdir()` root. Each directory below that anchor must be owned by the current user and disallow group/world writes; a shared writable runtime temp anchor requires sticky protection. Explicit global `/tmp` aliases are no longer accepted on hosts where they are not the runtime temp root. External session workspaces are revalidated before admission; managed workspace permissions are also checked. Canonical symlink targets containing Docker mount delimiters are rejected at project creation. Existing histories are retained if a workspace now fails these checks. Home, system/credential/configuration directories and invalid Docker mount syntax are rejected. Other mounted volumes are not supported in this slice. Worker network/capability/resource constraints remain in place; no host home, credentials or Docker socket mount is added.

## Scheduled work and cancellation

Each due schedule creates a durable execution before admission, retaining schedule/occurrence/request identities, due/start/end timestamps, input, model, status, answer, worker operations, approvals and failure events. Orbit run identity is recorded when supplied by real worker snapshots/results. Admission failures have no fabricated answer or Orbit run ID. Unfinished executions become interrupted on restart and are not automatically replayed. Saved conversation events are no longer shifted out after 2,000 records.

Schedules run only while the app is open. Missed recurring occurrences coalesce into one. Hourly/daily means elapsed-hour/24-hour intervals, not timezone-aware calendar recurrence. No OS service, wakeup or credentials are added.

Cancellation sends the worker a stop request, aborts host model calls, explicitly rejects late model RPCs, and gives the worker up to five seconds to close its transcript before Docker stop. Remaining owner/guard evidence blocks admission and moves instead of being deleted. Container ownership checks still apply. This preserves evidence after an unclean exit; automatic offline repair of container-PID writer ownership is not implemented.

## Upstream reuse decision

The examined Orbit source includes ProjectService and DurableWorkStore. ProjectService membership uses a registered SessionRepository pair with writer claims; the app currently has separate per-project core repositories in isolated workers. Safe adoption requires an explicit repository-pair migration. DurableWorkStore introduces additional ownership/replay and cross-store contracts, while the host currently has no Orbit dependency. This slice extends the existing atomic app Store and uses pinned worker event/request/run identities, avoiding a simultaneous runtime/storage migration.

## Validation

- Lint, typecheck, build and diff whitespace checks pass.
- Nineteen unit/policy tests pass, including original storage/cwd preservation through move/restart, directory-edit scope, additive legacy migration, execution/approval/result linkage, cancellation/re-submission, late-RPC cancellation and retention of leftover writer evidence. Lifecycle unit tests use explicit fake workers.
- Four Electron UI tests pass locally with normal Chromium sandbox settings: renderer isolation/narrow IPC, create/edit/cancel, rename/cancel/retry, move and restart persistence, outside/ESC dismissal and scroll preservation, disabled Move with enabled Rename during recovery, local SVG loading/24px geometry, interrupted execution details, and real scheduler admission failure persistence. The live test is opt-in and skipped by ordinary UI runs.
- An earlier real `gemma4:12b` turn completed and returned a remembered marker without tools. An actually running dedicated worker was cancelled and confirmed absent. Retry then exposed a retained Orbit owner record with container PID 1, prompting the cancellation changes above. No writer record or transcript was deleted.
- The configured existing image was previously confirmed as `sha256:b089106c52cce29187988972f8da14f8d8cb95c3cc78a063c42f38636ebbbf19` (linux/arm64, created 2026-10-03). An earlier absent/present detection discrepancy is unexplained.
- After disk cleanup, available capacity was 43GiB. An authorized Docker Desktop CLI restart failed while waiting for processes to stop. Normal macOS Quit/Open returned successfully, but bounded daemon reads still timed out. No image build/pull/install, volume/image deletion or factory reset was performed.

**Remaining live verification:** the corrected cancellation/re-submission and moved conversation's real Orbit history recall after restart require a responsive Docker daemon. They are not claimed to pass. Existing Ollama/model access alone cannot run the isolated worker. Re-run once Docker is responsive:

```sh
npm run build
ORBIT_APP_LIVE=1 ./node_modules/.bin/playwright test test/ui/live-approved.spec.ts
```

Ignored `test-results` artifacts contain local screenshots, the explicit live-test summary and failure traces. Existing security limitations in `verification.md` still apply; this change does not guarantee power-loss/fsync durability, hard disk quotas or tamper-proof journals.

## Sonar follow-up assessment

The 35 findings on the initial PR HEAD were evaluated individually by rule. S5443 (2) identified a meaningful unchecked shared-directory boundary; regression tests now reject publicly writable targets/parents, changed saved paths, delimiter aliases and unsafe managed workspace permissions, and prove rejected submissions never admit a worker. This is targeted hardening, not a guarantee against privileged/same-user mutation between host validation and Docker's pathname resolution. POSIX mode tests do not inspect extended ACLs, and live Docker checks remain blocked as documented above.

S9011 (3) flagged intentional default form submission rather than a reproduced misfire; explicit submit types now preserve that behavior. S6754 (3) flagged valid multi-declaration destructuring; each hook declaration is now separate. S9382 (1) flagged intentional sequential existence checks; the two read-only writer checks now run together and still retain evidence. S3776 (1) and S3358 (7) were addressed with named view renderers and explicit alternatives without changing component identity. CSS S4666 (2) duplicate overrides were consolidated with the same effective properties. S6772 (5), S6819 (2), S7723 (7), S6759 (1), and S7750 (1) were addressed with explicit label spacing, native dialog/output semantics, new Error, readonly props and findLast. The supported Electron/Node runtimes provide findLast; ES2023 library typing reflects that.

There are no automatic suppressions or changed Sonar settings. Remote analysis of the updated PR HEAD is the authority for remaining rule findings. The separate real-worker cancellation/retry and moved-history checks are still unverified while Docker is unresponsive.

The first follow-up Sonar analysis (`faccb23263d40fe9e096269001d49c8228b36c46`) closed all original 35 findings as FIXED, with Security/Reliability/Maintainability A and a passing gate. It reported one new MINOR S6754 setter-name finding, addressed by naming the run selection setter `setRunId`. Native dialog text explicitly inherits the approved palette. The latest remote check remains the authority for the final HEAD.
