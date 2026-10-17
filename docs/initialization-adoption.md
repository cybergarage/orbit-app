# App initialization

Orbit App uses the published, exactly pinned `@cybergarage/orbit@0.9.3` maintenance APIs. Electron userData is independent from CLI/embedded GUI `~/.orbit`. Initialization permanently deletes only the reviewed targets: no Trash, backup, staging copy, rollback or secure-erasure promise is provided. The App root itself is never removed.

## Persistence responsibilities and scopes

| Scope | Owned persistence | Retained |
| --- | --- | --- |
| Settings | `settings.json`: appearance (`system`, `light`, `dark`) | All registered data, schedules, per-chat models, project instructions and working files |
| Saved data | `registry/`: project/session membership, submission order, schedules, occurrence/execution history and runtime recovery identity; `catalog/`: core project SQLite and sidecars; each original core store's sessions, runs, logs and core SQLite/sidecars | Appearance settings, dedicated cache, internal working files and external workspaces |
| All | Settings and saved data plus exactly `cache/health.json` and its owned temporary write file | Unknown cache entries, Electron browser profile/cache, workspace/context files and all other unselected objects |

Session models, project instructions and schedule timing are saved records associated with their project/session, rather than global App preferences. Core-owned memory within the selected registered stores belongs to saved data; no separate external memory store is discovered. Health is cached runtime information, not an authoritative project record. Existing supported combined `state.json` profiles move to `registry/state.json` by rename; appearance and health are saved to their respective owned locations. Unsupported legacy name formats remain refused. No backup or alternate copy of the registry is retained.

Settings/all require explicit selection of App settings. Unknown settings fields, registry fields or entries in the consistent registry/catalog directories cause refusal instead of deletion. Unselected objects elsewhere remain untouched. The cache allowlist contains two files only; it does not include Chromium Cache, Code Cache, GPUCache, Local Storage or any entire browser profile. Working files, external workspaces, skills, AGENTS.md, ORBIT.md, environment credentials, plugin data, Docker and Ollama are outside scope.

## Registered namespaces

Worker stores are registered as `/state/sessions` and `/state/runs`; substituting their host aliases fails the core partner checks. A dedicated bounded, network-disabled, read-only-root maintenance container mounts only one original core directory at `/state`. It imports the published API and plans/executes in that registered namespace. It never mounts workspaces, catalog, home, credentials or Docker socket. All namespace mapping is host-derived, not accepted from renderer IPC.

The host aggregates these per-store metadata plans with the common API's App-owned registry/catalog/settings/cache plan. UI targets are mapped back to exact host paths. The aggregate ID binds scope, selection and all target identities. No registration metadata is rewritten and no coordination artifact is silently repaired. Pending/conflicting registration or remaining coordination ownership or unknown evidence blocks final review and execution. Persisted `.title.json` receipts are recognized saved-name data, not active ownership. These checks run in addition to the core's unchanged offline/partner checks.

## Shutdown, consent and execution

Preview returns paths, kinds, counts, sizes and retained scope, never configuration values or transcript contents. “Stop App writers and review final targets” synchronously blocks new commands and scheduled admission, invalidates pending admission, aborts and awaits title work, cancels/stops the Worker, awaits its completion and verifies cleanup, drains tracked operations and writes, and closes metadata helpers. SQLite is opened only in those bounded metadata containers, whose exit is awaited.

Before final review and again before execution, the host checks Docker mount sources and restart policies without reading container environments. Active or automatically restarting containers touching the App profile cause refusal; the adapter never stops unrelated containers. `lsof` must be available and its inspection must succeed. Writable, unclassified and ordinary regular-file handles block initialization. On Apple Silicon, a read-only regular-file cache handle is accepted only for the exact system Virtualization executable after Apple code-signature verification and after container writers/restarters have been excluded. Other regular-file readers receive no exemption. Read-only directory handles are not classified as writers. An unavailable inspection fails closed.

These observations do not prove arbitrary future external writes are impossible. The final explicit declaration requires the operator to stop external writers, disable restarters and maintain exclusive storage control. The user must also type `INITIALIZE`. A renderer cannot supply a profile, deletion paths or replacement plan; only the reviewed host plan ID is accepted.

Execution re-plans all targets, repeats external and per-store writer checks, then invokes the common API per original store and finally for App-owned persistence. Changed targets require a fresh review. Multi-store deletion is non-atomic. Failure reports completed paths, keeps the App offline and preserves a maintenance record; there is no rollback copy. Retry reviews the remaining targets and requires fresh consent. Uncertain half-pair registration or retained recovery evidence still refuses and requires offline operator review; the App never deletes evidence to force a retry through.

## Restart and crash behavior

The maintenance record is separate from all deletion targets. Interrupted, failed or unconfirmed shutdown resumes into a read-only maintenance screen after process restart. It does not reopen SQLite, resume schedules, generate titles or admit tasks. Invalid/unknown control records are refused without replacement. Successful execution records completion and requires process restart. The departing process cannot save stale in-memory state back over cleared data. Normal startup then recreates missing owned persistence and initializes new core stores through the usual registration API; retained working files remain untouched.

## Verification

All destructive verification uses newly generated isolated profiles only. Tests cover the three scopes, exact metadata preview and consent, preservation of internal/external working files and unknown objects, changed plans, retained core ownership evidence, open host handles, foreign containers, title abort, delayed admission, Worker cleanup uncertainty, per-store partial failure, maintenance restart and clean post-reset registration. Electron regression exercises all three flows and failure recovery using the actual host/IPC and published Worker image, without live model inference.
