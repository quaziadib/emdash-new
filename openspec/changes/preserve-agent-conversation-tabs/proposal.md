## Why

When a user switches to another agent in a new tab, the previous tab's conversation context is difficult to carry forward. Users need a lightweight, reviewable way to preserve complete tab transcripts and select them as context for the next agent run, similar to continuing work across Conductor tabs.

## What Changes

- Persist each agent tab's conversation transcript as a complete Markdown document in the app's durable conversation storage.
- Expose saved transcripts through a typed conversation API when creating a new chat/tab in the same workspace.
- Allow users to select one or more previous transcripts before starting the next agent run.
- Capture ACP and PTY transcript updates automatically and include selected transcript contents in the new conversation's initial context.
- Preserve existing transcript display and normal new-chat behavior when no prior transcript is selected.
- Revert or supersede the current partial tab-switching behavior where it conflicts with the durable transcript handoff flow.

## Capabilities

### New Capabilities

- `agent-conversation-continuity`: Preserve tab transcripts and let users attach selected prior conversations as context for a new agent tab.

### Modified Capabilities

None.

## Impact

- Conversation/tab lifecycle and new-conversation UI in `apps/emdash-desktop`.
- Transcript serialization, durable storage, and typed Wire procedures alongside the existing Markdown/export and conversation persistence primitives.
- New-chat initialization and initial-prompt/context plumbing for agent sessions.
- Tests for transcript persistence, selection, ordering, empty states, and context transfer across tabs.
