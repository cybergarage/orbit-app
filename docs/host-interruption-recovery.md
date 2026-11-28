# Host Agent interruption and recovery

Status: design proposal. This document does not add a recovery action, loosen
the execution gate, or enable another workspace command.

## Current behavior

Orbit App has two separate questions to answer when a Host Agent run is
interrupted:

1. **Has its Docker worker stopped?** The main process checks the saved run's
   owned containers. On startup this cleanup also runs when the readiness opt-in
   is off, using the saved owner rather than a current image tag or option.
2. **May the conversation run again?** Core may retain the session writer and an
   incomplete operation even after Docker cleanup. App reports this distinction
   and blocks execution. A removed container is not evidence that a dispatched
   operation succeeded, failed without effects, or never started.

The current sources are [startup and admission](../src/supervisor.ts),
[Host cleanup](../src/host-agent.ts), and
[writer verification](../src/worker.ts). The
[packaged readiness proof](../scripts/host-readiness-app-smoke.mjs) covers a stop
before approval, cancellation after dispatch, crash and restart with the flag
off, and a missing image. A stop before approval may finish normally as
cancelled. A dispatched operation without a confirmed outcome stays protected,
even when the expected Docker child was removed.

### Why a new chat is not a workaround

The supervisor has one app-wide active slot. It uses that slot to retain the
run's durable recovery identity, and guards new submissions and scheduled
executions while recovery is blocked. A separate chat ID is not an isolation
boundary: by default, chats in a Project share its workspace, and their
registry refers to the Project's Core storage. An explicitly configured
workspace can also be shared across Projects. A moved chat can retain its
original physical workspace and Core storage even when its Project changes.
See [session creation and storage](../src/store.ts).

Do not clear, replace, or move the occupied slot to let another chat run. An
empty chat or draft can be opened without accepting a run, but the UI must not
offer it as a recovery shortcut. Do not copy unfinished assistant or tool
output into a successor chat or promote it into Project memory.

The packaged crash fixture creates a second conversation in the same Project,
verifies that both chats resolve to the same workspace, and submits a fresh
request from the second chat. The occupied run slot rejects it before model
submission or a new Docker child, without changing either chat's execution
state or the retained journal and writer.

## Core boundary

The current [exact Core pin](../core-pin.json) exposes two different mechanisms.
Neither is a restart recovery action that App can call simply because Docker
reports a container stopped:

- `RunManager.reconcileRun` requires an in-memory run with a terminal result,
  no pending resources, no cleanup errors, and no recording failure. The
  manager cannot recover that live context after the Electron process dies.
- `recoverSessionWriter` is an offline operator procedure. It requires
  independent exclusion that survives the caller, inspection of recovery
  evidence, and no live or ambiguous writer. It is not a substitute for
  reconciling the operation outcome; App must not use it to delete an owner
  or guard while a profile or writer may be active.

Core owns journal transitions and writer release. App owns verification of the
Docker backend and truthful desktop status. Keep those responsibilities
separate.

## Durable Host identity

For new Host runs, App records the Core run ID, registered storage pair, saved
Docker owner, and admitted immutable reader/writer/probe image IDs in the
existing active slot before model or tool dispatch. The exact reserved run ID
is passed to Core as the turn ID. App records an approval attempt before it
sends a positive response to Core. The attempt is not an accepted grant, a
child receipt, or proof of an external effect. A failed save prevents that
dispatch. Older active records are not upgraded or replayed. The recovery
gate does not consume the new fields. Once the host restart check confirms
retained writer protection, App uses the saved identity to
inspect the exact Core run. The UI shows a short journal status only; the
new diagnostic exposes no operation IDs or approval digests. An end record does
not verify workspace changes or unblock the run.

The packaged restart proof checks the visible open journal status, one
unresolved intent, unchanged journal and writer ownership record, and no
replay after killing the synthetic Electron instance and restarting with the
probe disabled.

To run just the packaged readiness scenarios on macOS arm64 with Docker
running, use `npm run build -- --fresh-host-default` and then
`npm run test:electron-sqlite -- host-readiness`. Optionally set
`ORBIT_APP_TEST_DISPLAY` to an active display's exact label for the second
command. The fixture places and verifies its own window before interruption
and after relaunch; it does not change macOS display settings.

The packaged readiness suite separates four restart cases. It pauses only a
synthetic Electron instance immediately before removal of its exact exited
probe container, after the receipt is persisted but before Core records a
result. A second run uses that same crash point and injects a conflicting image
identity into its own synthetic registry. Another run waits for the synthetic
provider's follow-up request and verifies the matching Core operation result
already exists. The early-interruption case has no receipt. Relaunch checks
that the journal and writer evidence are unchanged, no probe is replayed, and
no raw receipt reaches the renderer. The pending, matching case displays a verified approval. If Core recorded
the original successful result for that exact binding, the notice and event
log report it separately. Zero unresolved operations alone is not evidence
that this particular probe result was recorded. The completed-result scenario
also closes App normally and launches a second time against the same retained
profile to verify that both inspections show the same result, the journal and
writer are unchanged, and neither Docker nor the model is called to replay it.

## Proposed next contract

Before adding operation-level evidence, bind the inspected record to the
canonical storage pair, session, run, operation, original approval digest, and
executor profile. For the Docker
backend, use the durable owner and immutable image identity admitted for
that run. Persist any future receipt before relying on it across a restart.
The receipt must be scoped to the actual child and operation; a mutable tag,
a process name, a host exit code alone, or missing output cannot settle an
effect. An interrupted command can remain unknown even after teardown.
Reject unsupported, incomplete, conflicting, or moved-scope evidence rather
than upgrading it to a completed operation.

### First evidence milestone: review only

Start with the fixed, read-only readiness probe. Its scope is narrower than
arbitrary shell, file writes, edits, or Git. It may establish whether the
specific approved probe ran; it cannot establish the state of workspace files.

| Evidence | What it establishes |
| --- | --- |
| App approval attempt plus the matching Core approval and intent | The exact operation was approved and prepared. An attempt alone proves neither dispatch nor completion. |
| Durable executor receipt bound to that same operation | Only the outcome recorded by that exact executor boundary. A stopped container, successful cleanup, or the existence of a Core end record is not a substitute. |
| Missing, malformed, duplicated or contradictory records, or a scope mismatch | Show the outcome as unknown. Do not assume the operation ran or did not run. |

Core should verify the original approval and operation binding. The executor
should attest only facts it saw and persist those facts before its ephemeral
child is removed. The App should show a coarse status without exposing approval
digests, operation identifiers, or raw output. Repeated inspection must remain
read-only and must neither replay the operation nor release the writer. Do not
reuse readiness evidence to reconcile a file edit or an unrestricted command.

The first capture step writes a private v1 receipt to the App's active
registry before explicitly removing its fixed probe container. It requires
the saved approval attempt to match the sole unresolved Core operation at
dispatch, then checks the expected output and Docker's owned container ID,
image, exit state and exit code. No receipt is synthesized on cancellation,
interruption before observation, or mismatch. The receipt survives an App
process restart while the active slot is retained; it is not an audit log
once the active slot is cleared. It is not sent to the renderer or used to
resolve the operation. On restart, App checks its saved scope, immutable image,
owner, child ID shape and single approval attempt, then Core independently
matches the binding against the original request, grant, command intent,
and any recorded successful result. The notice and event log report a
matching approval, recorded result, or unverified receipt without exposing
the receipt. None of these observations changes the writer gate or establishes
any workspace effects.

Before considering a write-capable recovery transition, specify reviewed
evidence for each permitted effect and require Core to revalidate under
exclusive ownership. A future transition should retain the original terminal
record, append any reconciliation as a separate durable record, and release
protection only after the record is verified. If the product later chooses to
allow a fresh run despite a retained session, it needs a separate design for
durable recovery slots and proven workspace/storage isolation. Neither
capability is part of this proposal.

### Next milestone: evidence for one existing-file edit

Start with a single approved `edit` that replaces one existing regular file
with different bytes. Exclude absent-file creation, multi-file changes,
commands and Git. The first milestone is diagnostic only: no replay,
rollback, journal transition, or writer release.

The current writer verifies the prepared preimage and result digests, syncs
the staged file, renames it over the target, syncs the parent directory, and
reads back the result. Its reply is not a durable receipt. A crash can occur
after rename and before the reply or the Core result is recorded. The
preimage check is an optimistic check, not exclusive ownership against an
editor or another process writing to the same workspace. The Core session
writer and App's active slot do not provide that filesystem exclusion.

| Evidence after restart | Diagnostic conclusion |
| --- | --- |
| Target matches the expected result, but there is no durable executor receipt | Expected bytes observed. This does not show which process wrote them or whether the edit ran. |
| Target matches the preimage, but there is no durable executor receipt | Original bytes observed. This does not rule out a write followed by a revert. |
| Target matches neither digest, disappears, or fails bounded regular-file validation | State changed or could not be verified. Preserve it and retain protection. |
| Exact receipt says the executor verified the result after the commit and sync steps, and current readback matches | The executor observed a committed edit at that time, and the expected bytes are present at inspection. The session still remains blocked. |
| A receipt conflicts with the current file, scope, image, child, or approval binding | Report the discrepancy; do not resolve the operation or treat the old receipt as current state. |

For an implementation PR, first define a versioned, private receipt for the
exact prepared edit. Bind it to the canonical workspace and target, Core
storage pair/session/run/operation and approval, the immutable writer image
and owned child ID, and the prepared preimage and result digests. Record only
facts verified after the commit and sync steps. Do not store file contents or
surface identifiers or digests in the renderer. A receipt persisted by App
after receiving a worker reply cannot cover a crash before that reply; keep
that window explicitly unknown. Start with synthetic files and fault
injection, and verify that repeated inspection cannot dispatch a model or
writer or rewrite the Core journal.

Use synthetic fixtures for interruption before rename, after rename but before
receipt persistence, and after a durable receipt but before the Core result.
Add cases where an independent writer leaves the same expected bytes or
restores the preimage without a receipt, and where it changes the file after
a valid receipt. These cases should produce different observations without
opening the execution gate. Simulated crashes establish ordering and
classification, not power-loss durability on a Docker bind mount.

A later PR may propose a Core recovery transition only if it can demonstrate
exclusive ownership across recovery and explicitly define the effect that can
be reconciled. In particular, a current digest match, a stopped worker and a
Core session lock do not by themselves prevent an external workspace writer
from changing the file between inspection and reconciliation.

### Acceptance criteria

| Scenario | Required result |
| --- | --- |
| Before approval or dispatch | A cancelled request without an operation never launches a child and does not need an effect receipt. |
| Stop after dispatch; owned container is gone | Report Docker teardown and retain the unknown outcome, journal, and writer protection; do not replay. |
| Crash during a run; reopen with the opt-in disabled | Locate only the saved owned child; inspect the same Core run; do not infer an outcome from startup cleanup. |
| Docker unavailable, reused identity, or missing receipt | Do not assert verified cleanup or accept a replacement effect; keep the run blocked. |
| Wrong storage pair, stale Project membership, invalid/torn record, or stale grant | Revalidate project scope and verify canonical storage; reject mismatches without mutating the journal or writer. |
| Live owner or concurrent recovery attempt | Fail closed without removing protection. A later write-capable transition needs a separate exclusivity test. |
| New chat, scheduled run, or another Project pointing at the same workspace | No bypass of the active-slot gate; no overwrite of the recovery identity, fallback, or automatic dispatch. |
| Inspection repeated or App crashes mid-inspection | Same evidence remains inspectable; no writes, no extra model submission, and no operation restarted. |
| Partial assistant/tool output | Preserve history but do not import uncommitted output into another chat or learn from it as settled Project memory. |
