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

## Proposed next contract

Start with a Core-owned, read-only restart inspection for one exact interrupted
run, not a release or replay API. It should report whether the evidence is
sufficient to *review* recovery, why it is blocked, and whether a writer is
still retained. No inspection should update the journal, transmit workspace
data, or launch an operation.

Bind the inspected record to the canonical storage pair, session, run,
operation, original approval digest, and executor profile. For the Docker
backend, use the durable owner and immutable image identity admitted for
that run. Persist any future receipt before relying on it across a restart.
The receipt must be scoped to the actual child and operation; a mutable tag,
a process name, a host exit code alone, or missing output cannot settle an
effect. An interrupted command can remain unknown even after teardown.
Reject unsupported, incomplete, conflicting, or moved-scope evidence rather
than upgrading it to a completed operation.

Before considering a write-capable recovery transition, specify reviewed
evidence for each permitted effect and require Core to revalidate under
exclusive ownership. A future transition should retain the original terminal
record, append any reconciliation as a separate durable record, and release
protection only after the record is verified. If the product later chooses to
allow a fresh run despite a retained session, it needs a separate design for
durable recovery slots and proven workspace/storage isolation. Neither
capability is part of this proposal.

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
