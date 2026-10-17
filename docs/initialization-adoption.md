# Initialization adoption status

The Worker pins published `@cybergarage/orbit@0.9.3` and its registry integrity in `worker/package-lock.json`. The image identity is `orbit-app-worker:core-0.9.3`. The dependency update does not enable destructive actions.

The published package exports `planInitialization` and `executeInitialization`. Its safety contract validates the session/journal pair recorded in `.orbit-session-binding.json`. App metadata and Worker helpers register this pair as `/state/sessions` and `/state/runs`. A host-side profile instead sees `userData/projects/<id>/core/sessions` and `runs`; passing these aliases directly fails with `Conflicting storage partner blocks reset`. The isolated regression test exercises the published package in the Worker image, confirms the matching container profile is accepted and the host alias is rejected, and performs no deletion.

An implementation must preserve this validation. Do not rewrite registrations or delete guards to make a plan pass. A container-aware maintenance adapter could plan each original store in its registered namespace, aggregate host-visible metadata and final consent, coordinate all writers, and report partial completion. Such an adapter is not implemented in this PR. A core API change is not proven necessary; direct host-path integration is insufficient.

`state.json` currently combines appearance preferences, project registrations, schedules, execution history and runtime metadata. Deleting it for settings-only initialization would also delete saved data. Settings must be separated deliberately, with restart validation, before enabling that scope.

The reviewed preparation UI does not define an exact persistent cache inventory. A completed adapter must identify App-owned cache paths and ensure Electron cache writers are stopped; it must never delete the entire userData root. Existing internal working files, external workspaces, shared skills/context, environment credentials, Docker and Ollama remain outside scope.

Remaining work: implement the namespace-aware maintenance adapter; separate settings and saved-data persistence; define owned cache paths; block admission and schedules; abort and await title work; stop and verify Workers and metadata helpers; create a final plan after shutdown; bind confirmation to that plan; show partial failures without resuming writers; and verify all scopes and restart using newly generated fixtures. Actual user-data initialization is not authorized.
