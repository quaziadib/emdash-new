## Context

The conversation UI already has a new-conversation modal, conversation configuration with an optional `initialPrompt`, and transcript rendering/persistence-related primitives. The checkout also contains an uncommitted continuation helper and tests, so the implementation should reconcile that partial work with the durable, multi-selection behavior described in the spec rather than introduce a parallel flow.

## Goals / Non-Goals

**Goals:**

- Define one workspace-scoped transcript source model for tab continuation.
- Make transcript serialization reusable by both persistence and the new-chat picker.
- Pass selected transcript content through the existing conversation initialization boundary.
- Keep the default new-chat path unchanged when no transcripts are selected.
- Provide deterministic ordering, source labels, and capability/error states.

**Non-Goals:**

- Reconstructing or resuming the provider's hidden runtime session state.
- Storing transcript bodies in SQLite; only transcript metadata belongs in the database.
- Cross-workspace transcript sharing, automatic transcript summarization, or provider-specific memory APIs.
- Replacing the existing transcript renderer.

## Decisions

### Store transcripts as first-class conversation data

The persisted artifact is a complete Markdown transcript under the workspace's `.emdash/transcripts/<conversation-id>.md` directory, matching the user-visible/exportable form and making handoffs inspectable. SQLite stores only metadata keyed by conversation id: workspace/project association, title, relative file path, and update timestamps. Transcript content has no application size limit; filesystem and transport failures are reported without interrupting the agent. Structured runtime events remain the source of truth, while the continuation boundary consumes the normalized Markdown document.

### Keep source identity alongside content

Each selectable transcript needs a stable id, workspace association, display title, updated time, and Markdown payload or resolvable path. The prompt builder should add a clear source heading before each document so the receiving agent can distinguish multiple tabs.

### Capture through existing runtime history boundaries

ACP history refresh/commit events and PTY output/session updates SHALL feed the transcript writer. The writer must be debounced, idempotent, and non-blocking so transcript persistence cannot delay prompt delivery. Existing export code should share the serializer where practical.

### Compose context at the new-conversation boundary

The picker returns selected transcript ids; a continuation service resolves them, validates workspace ownership, orders them deterministically, and builds the initial context. The modal passes the resulting context through the existing initial-prompt/config path so ACP and PTY behavior remain provider-specific at their current edges.

### Treat unsupported delivery as an explicit state

The UI should use existing agent capability metadata to disable or explain continuation when an agent cannot receive initial context. It must not persist a misleading successful handoff.

### Wire and UI boundaries

Add typed list/get transcript procedures to the conversations contract and controllers, scoped by project/workspace. The new-chat modal observes those procedures through a browser client and submits selected transcript ids; the node side resolves the latest records at creation time, reads the workspace-relative files, and rejects cross-workspace ids. File access must use existing path-safety helpers and never accept arbitrary paths from the renderer. Remote workspaces use the existing host file client rather than local Node filesystem access.

### Alternatives considered

- **Copy visible text directly from the renderer:** rejected because it is fragile, loses source identity, and couples persistence to DOM state.
- **Resume the previous provider session:** rejected because it does not support switching providers reliably and exposes hidden runtime state rather than a portable handoff.
- **Select only one transcript:** rejected because the target workflow explicitly combines several prior tabs.
- **Use arbitrary user-selected files as the primary source:** rejected because it does not preserve prior tabs automatically, cannot enforce workspace isolation, and makes stale or missing context invisible.

## Risks / Trade-offs

- [Large transcripts exceed provider prompt limits] → Show size/compatibility feedback, preserve the full saved files, and define a bounded delivery policy rather than silently truncating.
- [Transcript changes while the picker is open] → Resolve and validate selections at creation time, then report missing or stale sources clearly.
- [Sensitive data is copied into another agent] → Make selection explicit, show source labels, keep scope workspace-local, and avoid automatic inclusion.
- [Existing partial implementation diverges from the durable model] → Reuse compatible helpers/tests and remove or revise overlapping behavior during implementation.
- [Transcript files are moved or deleted outside the app] → Treat missing files as unavailable selections, retain metadata for diagnosis, and allow a later capture to recreate the canonical file.
- [Workspace paths are unavailable on remote hosts] → Resolve paths through the host/workspace file service and surface an explicit unavailable state.

## Migration Plan

1. Identify existing transcript persistence/export sources and adapt them to the workspace-scoped source model.
2. Add the metadata migration, safe workspace-file writer, typed Wire procedures, and runtime capture.
3. Add the picker and continuation composition behind the new-chat flow.
4. Verify existing new-chat and transcript restoration behavior with no selection.
5. Roll back by disabling the picker/context injection while retaining transcript records for future retry.
