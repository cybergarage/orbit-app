# Core-backed display names

Orbit App pins the published `@cybergarage/orbit` **0.9.2** package and its npm integrity in `worker/package-lock.json`. The single development image tag is `orbit-app-worker:core-0.9.2`; builds reuse that tag, never replace the preceding image tag, and runtime uses `--pull=never`. Neither a neighboring Orbit checkout nor an unpublished source artifact is used.

## Ownership and storage

The Electron main process still owns the App registry, project settings, schedules and event history. The app name, Electron `userData` selection, and original `projects/<id>/core` and workspace paths are unchanged. Renderer access remains the existing trusted-main-frame IPC boundary. It cannot supply host paths, arbitrary metadata operations, shell commands, catalog queries, or Docker arguments.

`ContainerCoreNames` uses the same read-only-root, network-disabled, capability-dropped, resource-limited worker image. A metadata operation mounts only the app-owned `catalog` directory at `/catalog` and a validated original core directory at `/state`. No host home, credentials, Docker socket, or project workspace is exposed to metadata operations. Linux containers use the non-root host UID/GID so private host directories retain their ownership and mode; no chmod or privileged user is needed. macOS retains the image user under Docker Desktop mapping. Ordinary inference workers continue to receive only their original core/workspace mounts and do not receive the catalog.

Project IDs map one-to-one to `ProjectService.create` operation IDs. The global core `SqliteProjectStore` persists Project names/revisions in `catalog/projects.sqlite`; Project rename uses `ProjectService.rename`. Session UUIDs map one-to-one to `SessionRepository` IDs. Session creation and initial `SessionRepository.rename` are separate operations, releasing the creation owner before rename. Core titles/revisions live beside transcripts in `projects/<original-project-id>/core/sessions/.coordination`. Original repository pair registration and `/state/sessions` / `/state/runs` paths remain stable across containers and membership moves.

App membership remains in its registry; adopting the core membership/reservation model is not part of this change. Moving a Chat preserves its Session ID, original core repository and title, while changing its App project membership and linked future schedules. It does not copy or rewrite transcripts. Existing execution `projectName` values are historical snapshots, not a fallback source for current names.

App snapshots contain names read from core. Current Project/Session names and revisions are omitted from `state.json`; no legacy name fallback or migration exists. Startup requires `namesVersion: 1` for nonempty registries. A preceding registry fails before normalization or saving and reports its existing data directory. No old data is removed, copied, renamed or reset automatically. To use the new format, the user must explicitly decide how to handle the old data outside this implementation. Normal app storage paths are not silently switched.

## Concurrency and errors

Rename editors retain the observed revision and a stable operation UUID. The main process validates the IDs and revision, checks App membership and busy/recovery state, then invokes core. Core owns transactional Project revision checks and registered Session writer claims/deletion checks. Exact operation replay is handled by core; changed input or stale revisions conflict. Failures do not update the in-memory name or close the editor. Snapshot refresh loads the authoritative core title while preserving unsaved editor input. Closing the app waits for outstanding IPC mutations before its final save.

SQLite catalog data and session coordination metadata are trusted local state. Approved runtime Bash still has access to that Chat's core directory, as before; this change does not make it tamper-proof. No writer guards or deletion evidence are deleted to make a failed rename succeed.

## Verification notes

Use new synthetic roots only. `npm run worker:build` must precede tests because storage tests and Electron UI now use real core metadata containers, while lifecycle inference remains explicitly mocked in unit tests. CI builds one image before the suites. The opt-in live suite separately exercises inference/cancel/resend with an installed local model.

Core 0.9.1 closed coordination creation descriptors before checking the path identity. On M4 Docker Desktop bind mounts (`fakeowner`), repeated creation at the same name could then report a different inode and correctly fail closed. Published core 0.9.2 retains those descriptors through identity/token verification and unlink, and closes them on failed cleanup or maintenance without deleting uncertain evidence. No inode check, stale-owner safeguard or Docker security setting is bypassed.

The 0.9.2 M4 qualification uses the published package in the actual Worker image, not a patched source mount. A fresh workspace bind mount passed 500 repeated claims/releases, 500 concurrent-writer refusals and identical-token replacement refusal. Existing retained guards from earlier failures are not repaired or deleted automatically; they still require explicit offline evidence review. All verification data is newly synthesized, separate from real App history.

App lifecycle/storage/policy tests (28 cases) and Electron UI tests (6 cases) pass with real core metadata containers. UI coverage includes normal/compact Debug behavior, menu dismissal, arbitrary Rename persistence through restart, revision conflicts, durable scheduler failure, and Retry input preservation. Lifecycle inference in these suites is explicitly mocked; real-model Worker verification is recorded separately in the pull request.
