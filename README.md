![Work in progress](https://img.shields.io/badge/status-Work%20In%20Progress-8A2BE2)
[![Build Status](https://github.com/cybergarage/orbit-app/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cybergarage/orbit-app/actions/workflows/ci.yml)

# Orbit App

Developer desktop workspace powered by [Orbit](https://github.com/cybergarage/orbit).

A local Electron desktop prototype for agent work. On a fresh native package,
Electron owns the Agent and sends workspace reads to network-disabled Docker
execution. File changes require a separate opt-in and per-operation approval.
The app never switches model providers as a fallback.

## Desktop preview

![Current Orbit App in Light appearance, showing compact Project and Chat rows and a completed synthetic conversation with Debug closed](docs/assets/orbit-app-demo.png)

Current Electron UI in Light appearance, with compact Project/Chat navigation, user messages on the right, answers on the left, and Debug closed. Captured from the running app using isolated synthetic demo data; no real tasks or personal information are shown.

## About Orbit

[Orbit](https://github.com/cybergarage/orbit) is the TypeScript agent execution framework underlying this app. It provides model adapters, including Ollama, tools, sessions, and execution and approval controls. Orbit App adds the desktop interface. In Host mode, Electron owns the Agent
and uses separate Docker executors for workspace operations. The retained
legacy route still runs its Agent in the Docker worker.

## Requirements

- macOS with Apple Silicon (verified on the secondary M4).
- Node.js 22.12 or newer and npm; CI uses Node 22, and local validation used Node 26.5.
- Running Docker Desktop and native Ollama at `http://127.0.0.1:11434`.
- An installed tool-capable Ollama model; `gemma4:12b` was verified. Models are not downloaded automatically.

## Install and run

```sh
cd ~/Src/orbit-app
# Both lockfiles pin the same published Orbit Core version and integrity.
# No separate Core checkout or vendored archive is required.
npm ci
npm run worker:reader:build
npm run package
open "release/Orbit App-darwin-arm64/Orbit App.app"
```

The native package opens the Host Agent by default for a fresh profile, with
Docker-only read and search tools. Create a project and chat, select a model,
and submit a task. Approved file changes are a separate opt-in below. Projects
use an app-managed workspace or a supported existing directory, and chats
retain their model choice and Orbit history.

Project knowledge is automatically extracted after successful conversations and
reused in related conversations in the same logical Project. No manual saving or
preview is needed. The supplementary **Project knowledge** panel provides source
inspection, correction, deletion, stopping and budgets. Closing windows keeps the
host running; explicit Quit stops it. See [use, migration, limits and validation](docs/project-knowledge.md).

## Build a local app

```sh
npm run package
open "release/Orbit App-darwin-arm64/Orbit App.app"
```

The normal unsigned macOS arm64 package builds the lock-pinned SQLite addon
for Electron using the native toolchain below. Docker and the locally built
reader image are still required; Docker images, models, signing and
notarization are not bundled. `npm run dev` and `npm run package:legacy` keep
the legacy build pathway available for source/developer checks.

### Verify Electron-host SQLite independently

On a native macOS arm64 development machine with Xcode command-line tools,
Node 26.10.0 and npm 11.19.1, run `npm run test:electron-sqlite` after
installing the normal locked App dependencies. The proof builds the existing
locked `better-sqlite3` source against the exact Electron 44.5.1 headers
(checked by SHA-256), packages a separate GUI-less test app with the native
module outside ASAR, then opens, writes, and reopens a synthetic Core Project
catalog inside its real Electron main process. It expects Electron ABI 149.

The proof downloads the pinned official headers; Electron Packager may also
fetch the exact Electron binary on a cold cache. The standalone SQLite probe
does not replace the normal Node test addon, use a real profile, start Docker,
or touch an App catalog. The native App package uses the same pinned build
path for its own Electron addon.

## Prototype features and limits

- Home/new-chat, project creation and editing with optional directory/instructions, session rename/move, conversation model selection, runtime health, operation approvals, cancellation, saved history, and top-level artifact listing.
- Scheduled definitions and a separate execution history with input, answer, operation/approval events and failure/interruption details.
- Session moves preserve original Orbit storage and working directory. Changing a project directory affects new chats only; project guidance affects future tasks. Running or recovery-pending sessions cannot move. Project/Chat names use the pinned Orbit Core APIs. Unsupported legacy name formats are rejected without data deletion. Supported combined profiles move their registry location without retaining a copy.
- Saved System/Light/Dark appearance and compact Project/Chat navigation, with Settings categories for Appearance and real runtime Status.
- One-time, fixed-interval and calendar schedules with a saved IANA time zone. Relative first runs start from successful creation; fixed intervals keep their planned anchor, while daily/weekly rules keep local wall time. **The app must be running.** Missed occurrences coalesce; interrupted work is not automatically replayed. There is no background daemon.
- Scheduled tasks have explicit Enable/Disable and confirmed Delete controls. Enabling retains a future slot or skips elapsed recurring slots while preserving the original interval/calendar anchor and time zone; past or already-admitted one-time slots require editing to a new future time. Editing a disabled task keeps it disabled. Disable/Delete prevent future admission and never cancel an already-admitted run. Delete removes only the definition: execution history, chats and working files remain. Changes persist across restart.
- First-input Chat titles are saved through core before Worker admission. A bounded local model call may refine the title after the task settles; manual names take priority.
- Intended for trusted local workspaces. Host-mode Docker executors receive only the selected workspace mount and no network, host credentials, or Docker socket. The legacy Agent still has workspace and Core mounts; its separately approved Bash is not a complete sandbox guarantee.
- Per-file limits and a storage watchdog are **not a hard disk quota**; rapid writes can still consume host disk space.
- Orbit's pinned `braces@3.0.3` dependency has an unpatched DoS advisory. Restricted search syntax mitigates the direct glob/grep path, but an approved Bash script can still invoke the vulnerable dependency.

See [core-backed names and storage requirements](docs/core-display-names.md) for the retained legacy metadata route and existing-data policy.

See [approved UI implementation and current validation](docs/approved-ui-implementation.md) for the latest local implementation status.

See [verification and security limitations](docs/verification.md) for tested behavior, the advisory, and residual risks.

Chats within each Project and the unassigned Chats group follow accepted user submissions, newest first. Typing, viewing, responses, names and scheduled work do not affect this order. Rejected requests do not move Chats; failures after acceptance keep their position. Order survives restart and project moves. Older Chats without explicit submission ordering retain their relative saved order until their next user submission; historical submissions have no reliable human/schedule origin and are not inferred. Project order is unchanged.

On the legacy route, Settings → Initialization supports settings-only, saved-data, and settings/data/dedicated-cache initialization through the pinned Orbit Core maintenance API. The Host Agent does not expose these operations. Each flow previews exact App-owned targets, stops and verifies writers, creates a final metadata plan, and requires explicit permanent confirmation and external exclusive-control declarations. Working files, external workspaces, shared context, unknown objects and browser profile data remain outside the allowlist. Incomplete initialization stays offline across restart; success requires restart. See [scope, ownership and failure behavior](docs/initialization-adoption.md).

Model choices come from Core's credential-aware provider catalog: choose Ollama,
Claude (Anthropic), or OpenAI together with a compatible available model in one list. Read-only Models
API verification is not an inference/billing check. Keys stay on the host:
Electron owns model transport in Host mode, and legacy workers use constrained
RPC. Settings defaults apply to
new chats; existing choices and admitted runs remain isolated. No models are downloaded.
The Host Agent and legacy worker pin the published
`@cybergarage/orbit@0.9.4-next.0` package, not npm's moving `next` tag.
[Core pin metadata](core-pin.json) records the source release and SHA-512
integrity verified against both lockfiles. To use the new pin on the legacy route,
rebuild its image with `npm run worker:build`; the runtime does not pull a
replacement or modify an installed app. Host Agent tools remain unchanged.


### Host Agent profile selection

With no override, the native package opens an existing valid Host profile or
creates a marked `-host-agent-native-v2` sibling when the legacy root is missing
or empty. A nonempty legacy root without a Host sibling stays on the existing
legacy route. If both profiles exist, the native package resumes Host; explicitly
use `ORBIT_APP_HOST_AGENT=0` to open the independent legacy profile. A malformed
Host profile refuses startup rather than silently opening a different history.
No chat, Project memory, or files are adopted or copied.

From the checkout, the legacy escape and explicit Host selection are:

```sh
npm run worker:build   # required by the legacy route
APP="release/Orbit App-darwin-arm64/Orbit App.app/Contents/MacOS/Orbit App"
ORBIT_APP_HOST_AGENT=0 "$APP"   # open only the legacy profile
ORBIT_APP_HOST_AGENT=1 "$APP"   # open only the separate Host profile
```

Electron owns the Host Agent, model transport, session/journal state, Project
source leases, and its SQLite catalog. Missing/invalid native SQLite refuses
startup; missing Docker reader refuses task admission. Neither failure reopens
legacy.

On the pinned macOS arm64 packaging toolchain, run `npm run test:host-package`
to build the ordinary package in a disposable location and verify fresh
default/no fallback, explicit legacy switch-back, approved file changes, and
the opt-in fixed readiness probe in one run. The packaged renderer shows the
bound command preview; denial does not launch the probe, while approval
executes and removes one owned Docker container. The same run verifies that
stopping before approval does not launch a probe, stopping a running probe
cleans it up, restarting with the opt-in off reaps the interrupted probe
without replay, and a missing image is reported before inference or fallback.
Docker cleanup does not establish the outcome of a dispatched command: Core
can retain its writer and the App stays recovery-blocked rather than accepting
a new run. The conversation and Status explain verified Docker teardown
separately from Core's protection. The App preserves the chat and does not
unlock, replay, or fall back. The smoke uses Docker and loopback models only.
The reader, writer, readiness and legacy worker tags must be unused; existing
tags are never replaced. For just the fresh-default smoke, use
`npm run test:host-default`. The Linux CI
job exercises the Docker and application fixtures, not native macOS packaging.

See [Host Agent and legacy profile adoption](docs/host-agent-adoption.md)
for the verified switch-back behavior and the prerequisites for any future
adoption action.

This slice supports chat and Docker-only `read`, `list`, `glob`, and `grep`.
The admitted workspace reader has one read-only nonrecursive workspace bind
and no network or state. Bash, project-native build/test, plugins, MCP, and
data initialization remain unavailable in this mode.
The Host Agent uses the standalone image below and does not fall back to the
legacy worker image or a host read. Interrupted runs are not replayed.
Retiring the legacy route is separate from selecting Host for fresh profiles.

File changes are separately opt-in: build `npm run worker:workspace:build`
and launch the Host Agent with `ORBIT_APP_HOST_AGENT_FILE_CHANGES=1`.
Use `ORBIT_APP_HOST_AGENT=1` as well only when you need to select Host explicitly.
Only `write` and exact-text `edit`
are added. File changes require existing parent directories. Multi-file
patches, shell, and Git are not exposed. Each file
change needs explicit approval of the Core-prepared operation. A one-shot
Docker executor mounts only the selected workspace (writable, without nested
mounts); the image contains neither Orbit nor SQLite. A missing image stops
admission; uncertain effects are not replayed or sent to another backend.

Run `npm run test:host-file-changes` on the macOS arm64 native packaging toolchain
for the packaged approval smoke. It uses a disposable profile and loopback
fixture, exercises the renderer's Deny and Approve buttons, verifies only
approved writes/edits, then reopens in read-only mode. It requires a local
Docker daemon and the two App runner tags to be unused. It refuses to replace
existing images and removes only the fixture tags that still match its own
image IDs.

Run `npm run test:host-catalog` for a disposable actual packaged App smoke:
create a synthetic Project over normal App IPC, quit and relaunch with the
same profile, verify its ID, and verify that removing the disposable bundle's
native addon fails without changing catalog bytes. The smoke points Docker
at an unavailable endpoint and does not contact model providers.

### Workspace-only execution boundary (development)

A separate Docker image handles one prepared `write` or `edit` request at a
time. The legacy route still uses its existing Docker worker for all tools
unless opted in. For local legacy development, rebuild that worker and the
runner, then opt in before launching:

```sh
npm run worker:build
npm run worker:workspace:build
ORBIT_APP_DOCKER_WORKSPACE_MUTATIONS=1 npm run dev
```

The App checks both image capabilities before starting a run and launches the
exact inspected image IDs. Old or missing images are rejected without falling
back to the worker or placing a session into recovery. Only
approved `write` and `edit` use the one-shot runner. Read, search, and shell
stay on their existing paths. Session and Project knowledge state remains in the
existing worker architecture.

The intended caller binds the selected workspace and authorizes the operation
through Core. The runner accepts a single JSON frame on stdin (up to 1 MiB),
mounts no session, Project catalog or credential directories, and returns only
a bounded text result. It opens the Linux-mounted workspace without following
symlinks, rejects hard-linked/nonregular targets and missing parent directories,
verifies the preimage again immediately before commit, and verifies the staged and
committed result digests. Creation uses a no-replace commit; overwrite is atomic.
The caller must not concurrently mutate the same workspace. As with ordinary
filesystem tools, verification and overwrite are not one atomic compare-and-swap
against independent host edits.

A refusal before commit is a known tool error. Missing/invalid reply, container
cancellation, or post-commit verification failure must be treated as unknown
settlement, never retried or rerouted to the host. The App stops the affected
worker without clearing Core's recovery guard. Inspect the actual workspace and
resolve recovery before requesting another change. No recursive directory
creation or profile migration is in scope.

The developer smoke check runs only generated files in a unique temporary
workspace and builds/removes its own uniquely tagged image:
`node --import tsx scripts/workspace-docker-smoke.ts`.


To opt into isolated reading and search independently, rebuild the regular
worker image and launch with `ORBIT_APP_DOCKER_WORKSPACE_READS=1 npm run dev`.
Only `read`, `list`, `glob`, and `grep` use this lane; both flags may be
enabled together. The one-shot reader has a nonrecursive read-only workspace
bind and no state, credentials, or Docker socket. Link traversal and special
files are refused. Each read request has its own bounded queue wait, 12-second
attach deadline, 32 KiB request cap, and 1 MiB serialized reply cap (independent
of the mutation acknowledgment cap). Traversal is capped at 12,000 directory
entries, 8 MiB per file and 32 MiB scanned per operation. If a read limit is
exceeded the tool reports a failure, not a partial success or a fallback.


### Standalone Docker reader image for the Host Agent

```sh
npm run worker:reader:build
node --import tsx scripts/workspace-reader-image-smoke.ts
```

This image packages only the existing bounded `read`, `list`, `glob`, and
`grep` implementation and its lock-pinned search libraries. Its build context
excludes the Orbit package, legacy Agent, metadata helpers, and session data.
The image has no Orbit Core or application SQLite module. The Host Agent
selects it whether Host is chosen by the fresh-package default or by
`ORBIT_APP_HOST_AGENT=1`. The legacy route does not use this image.
Linux CI verifies execution by immutable image ID with one nonrecursive,
read-only workspace bind, no network, no state or catalog mount, and only
disposable test files. The macOS package proof also verifies actual admission,
read-only use, and refusal without fallback when the image is unavailable.

### Opt-in fixed Host Agent readiness probe

The ordinary Host Agent still exposes only read/search by default, with the
existing separate file-change option. A development-only opt-in admits one
fixed Bash readiness probe per run; no general shell or project code runs.

```sh
npm run worker:reader:build
npm run worker:readiness:build
ORBIT_APP_HOST_AGENT=1 ORBIT_APP_HOST_AGENT_READINESS_PROBE=1 npm run dev
```

The only allowed `bash` input is `printf 'workspace command ready\n'` with
the fixed 12-second outer limit (omit the timeout or pass `12`). The
[Core #52](https://github.com/cybergarage/orbit/pull/52) approval binds that
command, the workspace, an immutable Docker image ID, network-off policy and
bounded output. Other inputs are denied before an approval can be requested.
The dedicated image has only the fixed probe; it does not read workspace files
or execute code from them. The workspace bind is read-only and nonrecursive, and
no App state, credentials, or socket are mounted. An unconfirmed result is
unknown, never retried or redirected to the host. Restart recovery uses only the
saved run-owned Docker identity.

### Other fixed workspace command experiments (not connected to the App)

`node --import tsx scripts/workspace-command-docker-smoke.ts` still exercises
a separate fixture image supporting a constant Bash probe, Git tracked index
entries, Node syntax validation and one local Node test file. These Git and Node
operations are not exposed by the Host Agent. No general shell, networked Git,
dependency installation, linked worktrees, or production builds are added.
The retained legacy route's existing Bash remains unchanged.
