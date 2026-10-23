# Automatic Project Knowledge

Project conversations automatically share source-bound decisions, constraints,
explicit corrections and verified facts. Normal use requires no manual saving,
selection or preview: finish conversation A, allow background processing to
complete, then ask a related question in conversation B in the same Project.
Chats have no shared pool. An answer already running retains its original context.

## Operation and controls

Open the supplementary **Project knowledge** panel to inspect processing state,
reserved and reported usage, source conversations and conditions. Stop/resume
controls extraction; existing knowledge remains available while stopped. Edit
corrects an item; delete retires it with a tombstone. Manual edits and retirement
are protected from automatic replacement. Weak contradictions remain pending and
are excluded from retrieval. Archive/restore controls preserve stored data and
exclude archived sources or Projects from new processing. Restore can make valid
sources available again. Source deletion or movement invalidates derived entries;
a move changes logical membership without moving transcripts or workspaces.

The host continues extraction when all windows close. Reopen the app to inspect
results. Explicit Quit drains/cancels host work; restart reconciles persisted jobs
and completed journals. Extraction failure does not fail the ordinary answer.
A subsequent conversation can start before extraction finishes and consequently
receive no newly learned item. There is no wait-for-learning admission barrier.

## Persistence and isolation

Typed jobs, candidates, reservations and manual tombstones use the existing
Project catalog. Stable job IDs, candidate fingerprints, source digests and
atomic apply prevent duplicate effects across retries. Only acknowledged,
completed/quiescent runs with an admitted logical Project snapshot and matching
membership are eligible. Unknown historical membership is never backfilled.
Before applying, the host rechecks that exact admission digest, source messages,
membership, archive state and ownership. Knowledge is untrusted historical
reference data and grants no tools or approvals.

Original storage pairs remain mounted at `/state/sessions` and `/state/runs`.
Helpers acquire canonical Core writer leases in stable order; no registration is
rewritten. Multiple original storage pairs can contribute to one logical Project.
The host releases every lease before model inference and reacquires them for
validation/apply. A policy-2 snapshot explicitly records cross-pair sources;
historical policy-1 snapshots retain their original same-pair rules. Workers
receive one frozen snapshot through the ordinary Core input/journal path.

Source helpers share a dedicated, labelled, mount-free PID namespace anchor.
Its PID 1 never owns session claims. Helpers have distinct observable PIDs, so a
killed helper is reclaimed by normal Core dead-writer recovery. Execution workers
never join that namespace. Unknown ownership or uncertain helper cleanup blocks
further admission rather than deleting lock evidence. A source capture is limited to 4,096 messages / 1 MiB and lease groups to 128
sessions; exceeding these evidence limits fails closed. Loss of the entire anchor
namespace or legacy unknown PID evidence can require operator recovery; do not
remove ownership files to force progress.

## Limits and accounting

Each Project has a durable queue cap of 32 unfinished retryable jobs, enforced
atomically at enqueue. A full queue postpones further capture without rejecting
ordinary conversations. Completed journals remain eligible for reconciliation.
Every attempt reserves 4,096 input and 1,024 output tokens before inference, with
at most three attempts per job. Default lifetime limits are 100,000 reserved input,
16,384 reserved output and 16 calls per Project. Controls can change limits but
cannot reset accumulated usage. Failed, interrupted and unknown-usage attempts
retain reservations. Reported usage is recorded separately; a reported overrun
pauses extraction. Stopped in-flight work may settle accounting but cannot apply
knowledge or start another call. Input is bounded, output allows at most eight evidence-bound
items, inference times out after 30 seconds, and response bytes are capped.
Oversized model input is discarded before reserving a call, freeing its queue slot.

The default extractor uses installed local `gemma4:12b` via loopback Ollama, with
no tools, temperature zero and a 1,024 output request limit. No model download or
external paid provider is automatic. Reservations bound admitted calls but are
not a billing guarantee: a server can misreport usage or ignore requested limits.
Prices are unknown; no monetary cost promise is made. Custom provider adapters
must enforce their own request limits and pricing policy. Credential-pattern
suppression is conservative and cannot detect every secret. Lexical English and
Japanese-bigram retrieval has limited semantic recall; evidence validation does
not prove the truth of a model's interpretation.

## Migration and local build

Core catalog schema 2 transactionally adds automation/extraction tables to schema
1 without rewriting existing rows. Interruption rolls back the transaction;
unsupported versions fail closed. Existing settings, schedules, Projects,
conversations, workspaces and original storage locations are retained. Optional
archive flags default to false. Existing transcripts without an admitted context
are not extracted into today's Project. Do not downgrade a schema-2 catalog into
a schema-1-only binary. No backup or relocation copy is created.

Settings-only initialization preserves catalog knowledge/jobs/accounting;
data/all initialization removes the catalog through existing reviewed targets.
The host stops extraction/helpers before initialization and preserves unknown
files and workspaces according to existing maintenance rules.

This unpublished integration installs the included audited Core artifact with
`npm ci`, then `npm run worker:build`. Both host and worker lockfiles pin the
same local prerelease tarball. Its SHA-256/source commit are recorded in
`worker/packages/core-artifact.json`; the image tag is
`orbit-app-worker:project-memory-local`. Other generated tarballs remain ignored.
Source rebuild is an explicit maintenance operation described below; it is not
required for fresh-checkout installation. Nothing is publicly released or
installed into the user's existing app. See the Core guide/ADR for contracts.

## Validation evidence

New feature tests are separate from baseline tests:

| Scenario | Evidence |
| --- | --- |
| A→B with a full queue, host restart, moved B with another original pair, exact source revision | `test/knowledge.test.ts` (real helpers/workers; fixed model responses) |
| Killed source helper, canonical reacquire, archive/restore | `test/knowledge.test.ts` |
| Close all windows during extraction, reopen/restart, stop/edit/delete | `test/ui/knowledge.spec.ts` (Electron/IPC/workers; fixed responses) |
| Core GUI A→B and supplementary panel | `test/ui/core-knowledge.spec.ts` (real Core GUI; fixed responses) |
| No model-time source locks, stale source/membership, failure, uncertain helper cleanup | `test/knowledge-faults.test.ts` |
| Settings retains new job; data/all removes catalog | `test/initialization.test.ts` |
| Concurrent bounded enqueue and SQLite restart | Core `extraction-queue.test.ts` |
| Crash before/after claim/inference/apply, atomic rollback | Core `extraction-recovery.test.ts` |
| Correction, tombstones, Japanese relevance, malformed output, budget/retry/usage | Core `automatic-memory.test.ts`, `memory.test.ts` |
| Additive/interrupted old schema migration | Core `store.test.ts` |

Fixed-response tests establish orchestration, not extraction quality. Live
synthetic-model trials are reported separately in the task result with their
actual path and call count. Full-suite results must refer to the final artifact;
earlier successful runs do not establish later changes.

The opt-in `npx tsx scripts/knowledge-live.ts` synthetic trial uses the real host,
source helpers, workers, catalog and snapshot path. It caps inference at two
ordinary requests and one local extractor call. On 2026-10-23, `gemma4:12b`
learned PostgreSQL and a fixture-only testing constraint, excluded tentative Redis,
and B reused both revision-1 entries. Extractor reported 427 input / 166 output
tokens against 4096 / 1024 reserved. Both ordinary runs completed. Earlier two
exploratory local calls were separate; total task quality calls were five. This
one case does not establish broad extraction, correction or multilingual quality.
No model was downloaded and no paid provider was called.

## Independent-review corrections

The host idle tick reconciles work at a five-second scan interval. A bounded
batch processes at most four jobs per Project, then schedules another wakeup
while retryable work remains. Failed attempts use bounded backoff based on the
persisted attempt count (one/two/four seconds; source/transport failures use a
five-second rescan). Admission/maintenance interruption and shutdown cancel the
pending wakeup; ordinary completion, Resume and budget changes wake processing.
The idle tick does not bypass an already scheduled retry. Stopped Projects and
exhausted budgets remain ineligible, with reservations and attempt caps retained.
No additional conversation or manual kick is required to drain startup backlog.

Extractor comparison context is relevance-ranked across all active entries, then
packed as whole items within the existing 4096-token input limit and sixteen-item
comparison cap. It no longer takes the first sixteen catalog items. Natural user
corrections do not need to contain IDs: the extractor can identify a supplied
related item, or leave the correction pending when its target is uncertain.
Untargeted corrections and lexical evidence of competing knowledge are held even
when titles differ. Cross-kind automatic decisions/constraints are distinguished.
This is conservative lexical screening, not complete semantic contradiction
detection: different vocabulary can miss conflicts, and shared generic words can
hold compatible items. No claim is made that every title paraphrase is resolved.
Pending uncertainty reduces automatic recall; it never grants permission or
silently overwrites an old entry. Manual corrections remain available.

Limit fields load saved values on the first status load for each Project.
Subsequent Refresh preserves the draft. Switching Projects/remounting the panel
loads that Project's saved config; changing one limit keeps the other saved
limits. Regression evidence: autonomous backlog/retry/resume/budget tests in
`test/knowledge-faults.test.ts` without explicit kicks, Core natural-correction /
late-target tests, and restart/switch/partial-edit UI in `test/ui/knowledge.spec.ts`.

## Pull request dependency and clean-checkout reproduction

This draft integration depends on Core source commit
`7c5288b336315e7fd3eeee562b244e23a8498ad7` in
`https://github.com/cybergarage/orbit.git` (Core PR #19). It uses no nonexistent
published version. The exact audited `0.9.3-project-memory.0` tarball is committed
under `worker/packages/`; its source and SHA-256 are recorded beside it. Both
lockfiles use this same relative file, so a fresh checkout runs `npm ci` directly,
then `npm run worker:build` and normal checks, without a local Core checkout.

CI separately checks out the pinned Core source and verifies that clean revision
and the included artifact hash before installation. The reviewed artifact has479
source/distribution files; inspection found no credential patterns, private
machine paths, session/database files or user data. It is an intentional package
dependency, not a backup or public release. SHA-256:
`17bb8964c7df8540c3e10f40331f8f98ddb53e7e2db35a6921f3129eb68e6eb2`.

Source rebuild remains available with `node scripts/prepare-local-core.mjs <path>`
on an explicitly selected clean checkout. The script refuses revision or artifact
hash changes. The initial Linux/Node22 CI rebuild produced different archive bytes
than the reviewed M4 artifact; it was not accepted by weakening the hash check.
Do not assume byte-identical archives across toolchains. Use the included pinned
artifact, or audit a deliberate rebuild and explicitly update its hash and both
locks together. No tool switches or rewrites another Core checkout.

Core must be reviewed/merged first. If its merged source differs, explicitly
update metadata and CI source commits, review/rebuild the package, update the
reviewed hash and both locks, rebuild the worker and rerun all checks. After a
separately authorized real Core release, replace both file dependencies with its
exact real version, regenerate both locks/image and rerun integration/GUI checks
before making this PR ready. No merge, release or deployment is authorized here.
