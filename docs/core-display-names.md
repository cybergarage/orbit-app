# Core-backed display names

Orbit App pins the published `@cybergarage/orbit` **0.9.1** package and its npm integrity in `worker/package-lock.json`. The single development image tag is `orbit-app-worker:core-0.9.1`; builds reuse that tag, never replace the preceding image tag, and runtime uses `--pull=never`. Neither a neighboring Orbit checkout nor an unpublished source artifact is used.

## Ownership and storage

The Electron main process still owns the App registry, project settings, schedules and event history. The app name, Electron `userData` selection, and original `projects/<id>/core` and workspace paths are unchanged. Renderer access remains the existing trusted-main-frame IPC boundary. It cannot supply host paths, arbitrary metadata operations, shell commands, catalog queries, or Docker arguments.

`ContainerCoreNames` uses the same read-only-root, network-disabled, capability-dropped, resource-limited worker image. A metadata operation mounts only the app-owned `catalog` directory at `/catalog` and a validated original core directory at `/state`. No host home, credentials, Docker socket, or project workspace is exposed to metadata operations. Ordinary inference workers continue to receive only their original core/workspace mounts and do not receive the catalog.

Project IDs map one-to-one to `ProjectService.create` operation IDs. The global core `SqliteProjectStore` persists Project names/revisions in `catalog/projects.sqlite`; Project rename uses `ProjectService.rename`. Session UUIDs map one-to-one to `SessionRepository` IDs. Session creation and initial `SessionRepository.rename` are separate operations, releasing the creation owner before rename. Core titles/revisions live beside transcripts in `projects/<original-project-id>/core/sessions/.coordination`. Original repository pair registration and `/state/sessions` / `/state/runs` paths remain stable across containers and membership moves.

App membership remains in its registry; adopting the core membership/reservation model is not part of this change. Moving a Chat preserves its Session ID, original core repository and title, while changing its App project membership and linked future schedules. It does not copy or rewrite transcripts. Existing execution `projectName` values are historical snapshots, not a fallback source for current names.

App snapshots contain names read from core. Current Project/Session names and revisions are omitted from `state.json`; no legacy name fallback or migration exists. Startup requires `namesVersion: 1` for nonempty registries. A preceding registry fails before normalization or saving and reports its existing data directory. No old data is removed, copied, renamed or reset automatically. To use the new format, the user must explicitly decide how to handle the old data outside this implementation. Normal app storage paths are not silently switched.

## Concurrency and errors

Rename editors retain the observed revision and a stable operation UUID. The main process validates the IDs and revision, checks App membership and busy/recovery state, then invokes core. Core owns transactional Project revision checks and registered Session writer claims/deletion checks. Exact operation replay is handled by core; changed input or stale revisions conflict. Failures do not update the in-memory name or close the editor. Snapshot refresh loads the authoritative core title while preserving unsaved editor input. Closing the app waits for outstanding IPC mutations before its final save.

SQLite catalog data and session coordination metadata are trusted local state. Approved runtime Bash still has access to that Chat's core directory, as before; this change does not make it tamper-proof. No writer guards or deletion evidence are deleted to make a failed rename succeed.

## Verification notes

Use new synthetic roots only. `npm run worker:build` must precede tests because storage tests and Electron UI now use real core metadata containers, while lifecycle inference remains explicitly mocked in unit tests. CI builds one image before the suites. The opt-in live suite separately exercises inference/cancel/resend with an installed local model.

On M4 Docker Desktop, a minimal synthetic bind-mount probe reproduced mismatching inode values between `fstat` after exclusive creation and subsequent `lstat` when repeatedly recreating one path. Core correctly rejects affected writer-claim cleanup with `Coordination identity changed; offline maintenance required`. This is an environment qualification blocker, not bypassed by this implementation. Existing data and retained evidence must not be repaired or deleted automatically. Linux CI results are separate from local M4 qualification.

Local evidence before PR: lint/typecheck/build pass; the initial 26-case real-metadata lifecycle suite passed after separating Session creation and rename. A subsequent aggregate with the additional conflict case passed 22/27 and failed five times at the inode protection above. Focused final Electron create/edit/rename/move/restart and external-rename conflict tests both pass. Full UI attempts also encountered the same filesystem protection; a test save-completion wait was corrected and verified by the focused rerun. These passes do not qualify the affected Docker bind filesystem. No suppression, automatic stale-owner cleanup, inode-check weakening, filesystem switch, or existing-data deletion was performed.
