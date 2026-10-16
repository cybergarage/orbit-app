# Approved UI follow-up — 2026-10-16

Local worktree: `orbit-ui-next`, branch `feat/appearance-schedules-titles`, based on main `c8fc62a`. Earlier worktrees and their changes are preserved. No backup, stash, legacy-data migration or real-history initialization is performed.

The follow-up uses approved Figma contexts for compact Home (`42:809`), Appearance (`9:78`, `79:3212`, `79:3306`), Status (`40:575`), scheduling (`9:80`, `71:2865`) and title generation (`75:2907`). All text uses 10px/15px. Home rows are 26px with 2px gaps; folder shape follows expansion independently of selection. Settings uses its own 40px category rows and keeps Status inside the existing global Settings destination. Appearance persists System/Light/Dark and applies throughout the renderer and initial native window. Figma icons are local SVG assets.

## Scheduling contract

New forms default to first run 15 minutes from successful creation and no repeat; reopening a new form resets those defaults. Relative creation retries use a stable operation ID and retain the committed anchor. Editing task/model alone preserves timing. Absolute past times retain inputs and show a corrective error. Preview and saved list show first/next time and IANA zone.

Fixed intervals advance from the first planned instant, rather than completion time. Calendar daily/weekly/custom-day-or-week rules advance the original saved local date/time in the saved IANA zone. DST gaps shift forward by the gap; repeated local times choose the earlier offset once. Later dates return to the original wall time. Legacy elapsed intervals remain elapsed intervals until explicitly edited; editing the task alone also preserves legacy 24-hour intervals. Named IANA zones are required rather than fixed offsets. Relative calendar anchors retain seconds and milliseconds.

The app runs schedules only while open. One tick is admitted at a time; active work delays scheduling. Missed slots coalesce to one attempt and the next slot advances beyond the current time without moving the original anchor. The execution ledger and next slot are saved before Worker admission. A crash may interrupt an attempt; startup records interruption and does not replay it automatically. This is not guaranteed delivery or an OS background service.

## Automatic titles and naming

Core 0.9.2 remains the pinned authoritative source of names, as established by main. No core dependency change or name migration is included here. New Chats save a whitespace-normalized first-input snippet (up to 40 Unicode characters) using the existing core Rename API before Worker start. Only after normal work settles idle does one bounded loopback Ollama call refine the title using the captured model and first input (up to 1000 characters). It receives no tools, files or conversation history; output is bounded, with a 15-second timeout and no automatic retry. Model failure, shutdown or new normal work retains the provisional title. Existing Chats are not automatically renamed.

Revision and job-generation guards discard stale output. Manual rename invalidates generation before saving. New normal work aborts title generation before admission. Metadata helper operations are serialized per App instance; core revision/operation contracts remain authoritative across processes. Restart discards unfinished title jobs rather than silently restarting inference. Only job flags are added to App state; formal names stay in core.

## Verification

All tests use isolated synthetic roots. Unit lifecycle tests inject fake Workers/model generators; core metadata integration tests use the existing pinned image. Electron tests use real host IPC and metadata persistence. Opt-in live tests separately exercise the existing local model and Worker. Final validation: lint, typecheck, build and whitespace checks pass; all 41 unit/policy tests pass; all seven Electron UI tests pass; three opt-in existing-model live scenarios pass. The real Worker returned MAPLE-6382, cancelled with its container confirmed gone, returned READY on resend, and recalled MAPLE-6382 after moving the Chat and restarting. Automatic title generation produced Kyoto Weekend Itinerary while preserving the single OK answer, then survived restart. All live fixture roots were removed.

Ignored `test-results/` retains normal/Debug/narrow/failure/Rename, Light/Dark/Status, Dark Debug and schedule screenshots, plus `live-approved.json`, `title-live.json` and `approval-live.json`. Screenshots were visually inspected. Local SVG load waits prevent premature capture and dimension checks. Earlier parallel test timeouts were resolved by waiting for asynchronous project creation/metadata preflight and rerunning the suites without competing Electron workloads.

A real approval-required Bash call was verified with Debug closed: Approve and Deny remained visible, no tool completed before approval, the exact console-only command was checked before approving, and execution then returned APPROVAL-7264. No file writes or external services were used. Policy/approval lifecycle tests also pass. DST, missed slots, long work and restart recurrence are verified with controlled synthetic time rather than waiting through real calendar transitions. Schedules still require the App to be open. Remote CI is reported separately against the exact pushed PR head. Merge, release and deployment remain outside this change. No model download, image build/removal or user-history write is performed for local verification.

---

> Historical UI implementation record. Current core dependency and name ownership are described in [core-backed display names](core-display-names.md).

# Approved Figma implementation update — 2026-10-15

Branch: `codex/approved-figma-ui`, based on fetched `origin/main` at `6c0172b` (PR #5). The original checkout was clean and remains on its original main; no stash, backup, or history copy was created. This worktree reuses the existing dependencies through an ignored symlink.

Implemented from Figma file `fdA4ptdJQKfwkB7UGWT943`: normal `4:7`, Debug `64:2301`, narrow `65:2465` / `66:2709`, Project rename `42:809` / `65:2627`, Chat rename `43:802` / `65:2789`, failure `65:2951` / `67:2768`. Design context and screenshots were read before editing. Prototype review controls, sample branding, sample messages and sample names are not production content.

The conversation places user messages right and answers left. Raw events and runtime reasons appear only in the optional right Debug pane. At widths up to 1200px Debug overlays the conversation. Approval controls, failures, interruption/cancellation history and Stop remain accessible without Debug. Debug retains events when closed, offers real workspace-file refresh and the existing schedule editor. Project rows provide new Chat and menu icons; Chat rows provide menus. Outside click and Escape close menus without navigation. Rename uses editable pages, actual persisted names, validation, Cancel and Save name. Project rename changes only the name; directory, guidance and session storage remain intact. Failed/cancelled/interrupted conversations restore their last real input for editing and Retry with a new request ID.

The host Store remains authoritative for App project/chat labels (`state.json`); the container receives session IDs, prompt, model and original workspace/core paths. Worker dependency remains pinned to `@cybergarage/orbit` 0.8.1. No new core release or data migration is needed for this UI. Adopting the new core rename APIs separately would require adding a host/core integration and explicitly reconciling App metadata versus core identity/storage contracts; do not change the Worker pin or migrate existing histories as part of this UI.

All verification uses fresh synthetic temporary roots through `ORBIT_APP_TEST=1` / `ORBIT_APP_DATA`. The legacy first-run backup creation was removed to honor the explicit no-backups requirement. No real user history was opened or modified, and no Docker image/model was built, pulled or removed.

Validation: lint, typecheck, build, 26 unit/policy tests, and five Electron UI tests pass. Screenshots in ignored `test-results/approved-*.png` cover normal, Debug, narrow closed/open, failure and Project rename; existing tests also cover Chat rename/restart, move, schedule history, outside/Escape and local icon geometry. Unit lifecycle tests use fake workers; UI tests use actual host IPC, Store and scheduler with synthetic data. Failure Retry exercises real host admission rejection and input retention. Live verification now passes using the existing fully qualified image `docker.io/library/orbit-app-worker:0.1.0`. Docker Desktop's `desktop-linux` context points to `/Users/skonno/.docker/run/docker.sock`; default `/var/run/docker.sock` is a symlink to the same socket. Short-tag `image inspect orbit-app-worker:0.1.0` fails, while the full `docker.io/library/` name, image ID and digest resolve to `sha256:964578b3d404cffc335ef62d886bee2b8c2675361ade25c9b8cdf1d8adc6699f` (linux/arm64, created 2026-10-03). The runtime now uses that fully qualified tag. No daemon/context change, image download, rebuild, deletion or retagging was needed.

The opt-in Electron live test passed in 19.2 seconds with existing `gemma4:12b`: actual inference returned `MAPLE-6382`; the running worker was cancelled and its container confirmed gone; resend returned `READY`; moving the Chat, restarting the app and resuming the original Orbit history recovered `MAPLE-6382`. All four submissions used synthetic data and no tools/approvals. The isolated fixture was removed. Evidence is retained in ignored `test-results/live-approved.json`. Real pending-approval rendering remains unverified; approval boundary/lifecycle unit tests pass.

This implementation is prepared for a Draft PR. Merge, release and deployment remain outside the authorized scope.

---

## Historical implementation notes (preceding this update)

# Approved desktop UI and persistence contracts

This implementation builds on `e87330e094f2a55bda172b78c808ce05b0da5658` and keeps the worker pinned to Orbit 0.8.1. It changes the Electron/React app; Orbit upstream and Nest are unchanged.

## Screens and interactions

The light theme uses locally stored Figma Dock SVGs. Home and New chat share a composer. Home/Scheduled/Settings navigation, project creation/editing, session rename/move, conversation model selection, and persistent Runtime status use actual application state. Connection details show Ollama, Docker daemon, worker image and the last check timestamp. No Figma example values are used as application data.

Session menus open through right-click or the ellipsis button. Outside pointer interaction is consumed and closes only the menu; ESC preserves the screen, selected conversation and timeline scroll. Rename remains available during recovery. Move is disabled in the UI and rejected by the host while running, admitting, awaiting approval/cleanup or recovery. There is no Dismiss button.

## History and directory preservation

The additive metadata migration retains existing project/session/event/schedule collections and core files. Initialization no longer creates `state.pre-approved-ui.json` or any other backup. Existing metadata is normalized in place using the established atomic save path. Core journals and transcripts are not physically moved or copied.

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

**Historical PR #4 live verification gap:** the corrected cancellation/re-submission and moved conversation's real Orbit history recall after restart require a responsive Docker daemon. They are not claimed to pass. Existing Ollama/model access alone cannot run the isolated worker. Re-run once Docker is responsive:

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

## Cancellation classification follow-up

The host retains a request-scoped cancellation intent and correlates host model-cancellation events with the worker's raw result. Only an effective cancellation with cancellation evidence receives the cancelled display classification; independent failures retain failed. Successful terminal results remain completed even if a stop races completion. Raw worker outcome/reason and request IDs remain in history and are visible in result messages. Events received after a request finishes are archived under that request and cannot overwrite the next request's status or answer. Cancellation intent is recorded once, including whether it was effective.

The targeted regressions cover repeated cancellation, delayed run phases/results, genuine failures before/after cancellation, successful completion racing stop, restart persistence and cancellation followed by a fresh request. The opt-in real Worker test now asserts cancelled display and retained intent, then checks real re-submission and moved/restarted history recall; its generated fixture is removed on exit. No worker image/dependency changes are required.

On the cancellation follow-up candidate, the existing pinned Worker passed real cancelled display, request-scoped intent retention, cancellation followed by successful re-submission, and project move plus application restart followed by real recall of the original marker. The final live worker outcome and host display were both cancelled, with the raw outcome retained. A targeted unit regression reproduces failed/runtime-failed from model cancellation and proves the display becomes cancelled without rewriting that raw result. All generated fixture data was removed by the test. Unit coverage now includes genuine failures, successful/late completion, budget/incomplete outcomes, stale prior-worker events, repeated cancellation and scheduled preflight cancellation. No cache/volume prune or dependency update was performed.
