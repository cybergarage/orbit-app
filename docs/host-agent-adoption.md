# Host Agent and legacy profile adoption

The native package defaults to a **separate** marked Host profile for fresh
launches and resumes its valid Host sibling when present. Existing nonempty
legacy profiles without a Host sibling remain legacy. Explicitly setting
`ORBIT_APP_HOST_AGENT=0` opens the legacy profile; `=1` selects Host. Neither
selection imports legacy chats, Project memory, or workspace files. This is
reversible profile selection, not a migration. The legacy profile can still relocate a supported root
`state.json` to `registry/state.json` by rename. Unsupported legacy name
formats remain refused.

Run `npm run test:host-profile-transition` on the macOS arm64 native packaging
toolchain with Docker running and the legacy worker tag unused. The fixture
uses two disposable profile roots, the actual packaged App, real Docker and a
synthetic loopback model. It verifies a legacy-created chat moved between two
Projects, a persisted Project memory entry, byte-for-byte integrity of the
legacy Core store and catalog during the Host phase, and recovery of the same
chat, original workspace, and memory selection after switching back. It does
not migrate data and never opens a real profile.

## Before offering an adoption action

1. **Read-only review first.** Inventory the one authoritative App registry,
   Core catalog, original session/journal pairs, and their current Project
   membership. Report refusal reasons without writing or touching settings.
   Moved chats keep their original storage pair and workspace; do not infer
   either from the destination Project. Preserve IDs, membership revisions,
   memory-entry provenance and existing journal outcome records.
2. **Define a supported namespace transition.** Legacy Core pairs are
   registered at the exact container roots `/state/sessions` and `/state/runs`.
   The same files opened under host aliases fail the current pair checks.
   Legacy chats also carry `orbit-app` and `/workspace`; Host accepts its own
   originator and a selected canonical workspace. A reviewed Core/App contract
   must resolve both bindings, preserve identity and keep the original
   transcript unchanged. Do not map arbitrary paths from an IPC request, edit
   registration files by hand, or use repair paths that create evidence copies
   as an adoption mechanism.
3. **One owner before and after.** Stop and drain the old App, scheduled
   admission, sources, catalog, and executors. Refuse retained ownership,
   unknown effects, or ambiguous profile/layout choices. Gate the same
   authoritative profile with one lock shared by both modes before granting
   any write authority. The two existing sibling profile locks are not a
   substitute for this cutover lock.
4. **Start without writes and verify rollback.** First prove history and
   Project memory stay readable in a read-only candidate on the same
   authoritative storage, including moved chats with a different current
   membership and physical pair. A mode switch must be reversible at that
   stage without copies. Do not promise rollback after Host writes until the
   unchanged legacy reader/writer is verified compatible or the product
   explicitly refuses unsafe rollback. Decide this contract before changing
   the default.
