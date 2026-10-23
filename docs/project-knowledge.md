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

Source rebuild remains available with `npm run core:prepare -- <path>`
on an explicitly selected clean macOS/Linux checkout (`/usr/bin/git`). npm supplies
its absolute CLI path and the script invokes it with the current Node binary; it
does not search PATH for subprocess executables. The script refuses revision or artifact
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


Core PR #19 was merged as `4d880deee0f5d4edbdc831e4ccc17dfb26a91e98`.
Its source tree matches the pinned source commit above exactly; the included
artifact and both locks therefore remain unchanged. This is still a vendored
integration package, not a registry release.


### PR CI follow-up

Both initial exact-head Linux runs passed81 of82 unit cases; the additional
12-Project visibility fixture was cancelled at its unchanged120-second limit.
A measured M4 run of the old full workload took70.9seconds. Both unit suites use
`--test-concurrency=1` (and UI uses one worker); this was not parallel fixture
interference. Each metadata request starts an isolated container. Repeating chat
creation and rename in all12 Projects added30 lifecycle admissions; independently
querying catalog identity in all12 added another10 duplicate reader admissions.
The fixture now retains all12 real create/configure/readback sequences with
background idle ticks, and independent catalog-reader plus complete chat lifecycle
checks on the first and last Project. Per-stage timestamps remain in logs, the
120-second limit is unchanged, and cancellation stops further iterations. This
changes test workload composition, not a claimed fix for the earlier unreproduced
Project-not-found error.

Sonar follow-up in app: lock acquisition uses an explicit locale-independent
comparison matching Core; source verification invokes `/usr/bin/git`, regeneration
uses the current absolute Node executable plus npm's absolute CLI path, and CI and
worker installs use `--ignore-scripts`. CI explicitly runs only the pinned Electron and SQLite binary installers;
the worker explicitly installs the pinned SQLite binary. A local script-disabled
worker initially lacked that binary and failed the visibility fixture, so the
explicit installer was added before publication. No quality-gate thresholds or exclusions were changed. Core's
merged Sonar observations are recorded separately; no post-merge Core changes are
included here.

The final local follow-up passed10 targeted cases (fault/accounting, package pin,
visibility). The restructured visibility case took46.3seconds on M4, versus70.9
for the old workload; the intermediate version took51.2. lint/typecheck and
source verification with an intentionally empty executable-search PATH passed.
Worker SQLite `select1` and the three audited Core module hashes matched after
explicit binary installation. Runner timing and final gates are checked on the
new exact PR head; local timing is not proof of Linux completion.

A subsequent full local UI run reproduced a different concrete failure:
`Corrupt project catalog` immediately after the second Project was created.
The bounded trace showed Store create-session and knowledge queries starting
through different metadata clients at the same time. Each client had its own
queue, so host coordination did not actually cover the shared catalog. App now
shares one metadata lane per validated profile across these clients; separate
profiles remain independent, failed calls do not strand the lane, and closing one
client rejects new work without closing another. No storage paths, writer claims,
Core code, package bytes or catalog checks are bypassed. A deterministic two-client
ordering/failure/close regression and the previously failing actual UI path pass.
This fixes demonstrated helper overlap; it does not establish the physical cause
of the corruption message or identify the earlier Project-not-found error.
Future failed synthetic UI profiles are retained in place for diagnosis; no copy
or user-data backup is created. Successful fixture profiles are still removed.
Final complete suites must include this additional coordination change (83 unit
cases expected); earlier82-case success predates it.

### Metadata helper lifetime and recovery

The follow-up review identified a P1: killing `docker run`'s CLI did not prove the
container stopped, so timeout/output-limit rejection could release the shared
lane while a catalog writer survived. This is addressed independently of the
unexplained corruption/UI errors; no causal identity is claimed.

The host now creates a stopped container first, synchronously records its exact
ID/name, profile/core paths, process owner and per-helper ownership label in a
private `.metadata-helper.json`, then starts it attached. Atomic metadata-file
updates are lifecycle evidence, not copies/backups of user data. An interrupted
create cannot start a writer before the ID is known. On timeout, output overflow,
CLI failure or malformed output, the lane remains held while the host verifies
that exact container's labels, removes it and confirms absence. Uncertain cleanup
retains the record, blocks every metadata client and makes shutdown/initialization
fail closed. No later catalog operation is admitted merely because the CLI ended.
A normal result is emitted by names.mjs only after `catalog.close()` completes.

After stopping the App, recover an owned helper explicitly from this checkout:

```sh
npm run metadata:recover -- /exact/App/profile/path
```

Recovery validates the private record, refuses a still-live foreign process owner,
and verifies exact container ID/name/profile/core/ownership labels before removal
and absence confirmation. Unknown ownership or a malformed record is refused;
preserve the evidence for operator review rather than deleting it to bypass the
fence. A restart also refuses pending helper evidence until recovery completes.
Core repositories, registered source paths and existing user data are not altered.

Tests exercise independent real CLI/writer processes for timeout/output overflow/
CLI exit, shutdown waiting, queued-request fencing, stop refusal, ownership changes,
and recovery. A real Docker helper remains running after CLI termination; the
new-process fence and durable-ID recovery are tested against that container.
The unrelated Linux UI failures are synchronized to actual budget-action completion
and explicit relaunch evidence, not a five-second DOM poll or an assumption that
click resolves before the renderer closes.

Runner stage logs on0e00171 show monotonic progress through all12 Projects: final
create107.5s, chat create110.2s, rename115.5s, configure118.2s and readback122.2s.
Therefore the visibility fixture's total bound is now180s, preserving the40-admission
reduction, all12 assertions, serial execution and each helper's30s bound. This is
based on measured finite workload plus explicit create/stop verification, not an
unexplained stalled assertion; stage errors still fail immediately. The existing
25-minute overall CI budget is unchanged.

Final full validation caught one protocol regression: nonzero helper exits were
replaced by a generic CLI error, hiding Core revision-conflict details. Structured
Core error replies are now preserved after the same required owned-container
cleanup; unstructured exits remain bounded generic errors. The exact failed real
revision/replay/membership test and7 coordination/lifecycle regressions pass.
The previous87/88 full result is retained as failure evidence, not reported as a
successful final run; full89-case and full UI validation follow this correction.
