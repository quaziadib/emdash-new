## 1. Transcript source and serialization

- [x] 1.1 Trace the existing conversation persistence/export paths and define a versioned workspace-scoped transcript record; verify it identifies conversation, project/workspace, title, update time, and complete Markdown content.
- [x] 1.2 Add SQLite transcript metadata plus safe workspace-relative `.emdash/transcripts/<conversation-id>.md` file operations; verify database and filesystem tests cover empty, multi-turn, update, missing-file, and cleanup cases without imposing a content-size limit.
- [x] 1.3 Implement or adapt transcript serialization so user, assistant, tool, and visible metadata are preserved; verify with unit tests covering empty, multi-turn, and updated transcripts.
- [x] 1.4 Capture ACP history commits and PTY conversation updates through a debounced, non-blocking writer; verify capture failures do not interrupt prompt delivery.
- [x] 1.5 Add typed conversation-domain list/get transcript procedures and controllers, including content loading through the host file service; verify cross-workspace ids and unavailable files are rejected by node and contract tests.

## 2. New-tab transcript picker

- [x] 2.1 Add the persisted transcript list and empty state to the existing new-conversation modal using the typed transcript client; verify prior sources are displayed with distinguishable labels and no-source flow remains usable.
- [x] 2.2 Add zero/one/many selection state with removal and deterministic ordering; verify selection behavior with renderer tests.
- [x] 2.3 Add agent capability and transcript-size feedback for unsupported or oversized handoffs; verify the UI does not report success when delivery is unavailable.

## 3. Context handoff

- [ ] 3.1 Implement a continuation context builder that resolves selected ids at submit time through the node/domain boundary, validates workspace ownership, loads current file contents, and adds source headings around each Markdown transcript; verify ordering and missing-source behavior with unit tests.
- [x] 3.2 Integrate the built context with the existing initial conversation configuration for supported ACP and PTY paths; verify selected transcripts reach the new agent and no-selection creates no initial context.
- [x] 3.3 Reconcile the current partial continuation helper/tests with the durable multi-transcript model and remove conflicting behavior; verify existing conversation creation and transcript restoration tests still pass.

## 4. Integration verification

- [ ] 4.1 Exercise the full flow: open a workspace with multiple tabs, create a new tab, select multiple transcripts, and confirm the new agent receives all source-labeled content; verify with browser/integration coverage.
- [x] 4.2 Run focused conversation tests, typecheck, and lint for touched packages; verify the new-chat default path and workspace isolation remain green.
