# Approved desktop UI and persistence contracts

This implementation builds on `e87330e094f2a55bda172b78c808ce05b0da5658` and keeps the worker pinned to Orbit 0.8.1. It changes the Electron/React app; Orbit upstream and Nest are unchanged.

## Screens and interactions

The light theme uses locally stored Figma Dock SVGs. Home and New chat share a composer. Home/Scheduled/Settings navigation, project creation/editing, session rename/move, conversation model selection, and persistent Runtime status use actual application state. Connection details show Ollama, Docker daemon, worker image and the last check timestamp. No Figma example values are used as application data.

Session menus open through right-click or the ellipsis button. Outside pointer interaction is consumed and closes only the menu; ESC preserves the screen, selected conversation and timeline scroll. Rename remains available during recovery. Move is disabled in the UI and rejected by the host while running, admitting, awaiting approval/cleanup or recovery. There is no Dismiss button.

## History and directory preservation

The additive metadata migration retains existing project/session/event/schedule collections and core files. An existing state file is copied exclusively to `state.pre-approved-ui.json` before its first upgrade; this file is never overwritten. Core journals and transcripts are not physically moved or copied.

Each session records its original `storageProjectId` and host `workspace`. Membership moves retain both values, so future workers reopen the original Orbit core and the original directory mounted at `/workspace`. Linked future schedules follow membership, while past execution records retain historical project identity. Directory changes affect new conversations only. Future tasks receive current project guidance alongside an explicit instruction to follow workspace ORBIT.md / AGENTS.md guidance; this does not replace Orbit policy or instruction discovery.

Optional directories must already exist below the user's home or a local temporary root. Home, system/credential/configuration directories and invalid Docker mount syntax are rejected. Other mounted volumes are not supported in this slice. Worker network/capability/resource constraints remain in place; no host home, credentials or Docker socket mount is added.

## Scheduled work and cancellation

Each due schedule creates a durable execution before admission, retaining schedule/occurrence/request identities, due/start/end timestamps, input, model, status, answer, worker operations, approvals and failure events. Orbit run identity is recorded when supplied by real worker snapshots/results. Admission failures have no fabricated answer or Orbit run ID. Unfinished executions become interrupted on restart and are not automatically replayed. Saved conversation events are no longer shifted out after 2,000 records.

Schedules run only while the app is open. Missed recurring occurrences coalesce into one. Hourly/daily means elapsed-hour/24-hour intervals, not timezone-aware calendar recurrence. No OS service, wakeup or credentials are added.

Cancellation sends the worker a stop request, aborts host model calls, explicitly rejects late model RPCs, and gives the worker up to five seconds to close its transcript before Docker stop. Remaining owner/guard evidence blocks admission and moves instead of being deleted. Container ownership checks still apply. This preserves evidence after an unclean exit; automatic offline repair of container-PID writer ownership is not implemented.

## Upstream reuse decision

The examined Orbit source includes ProjectService and DurableWorkStore. ProjectService membership uses a registered SessionRepository pair with writer claims; the app currently has separate per-project core repositories in isolated workers. Safe adoption requires an explicit repository-pair migration. DurableWorkStore introduces additional ownership/replay and cross-store contracts, while the host currently has no Orbit dependency. This slice extends the existing atomic app Store and uses pinned worker event/request/run identities, avoiding a simultaneous runtime/storage migration.

## Validation

- Lint, typecheck, build and diff whitespace checks pass.
- Seventeen unit/policy tests pass, including original storage/cwd preservation through move/restart, directory-edit scope, additive legacy migration, execution/approval/result linkage, cancellation/re-submission, late-RPC cancellation and retention of leftover writer evidence. Lifecycle unit tests use explicit fake workers.
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
