## Purpose

This capability lets users carry complete agent-tab conversations into a new tab so an agent switch does not discard the context needed to continue work.

## ADDED Requirements

### Requirement: Persist tab transcripts

The system SHALL preserve each eligible agent tab's complete conversation as a Markdown transcript associated with its workspace and tab/session identity.

#### Scenario: Conversation produces a transcript

- **WHEN** a tab contains user, assistant, tool, or other visible conversation content
- **THEN** the system SHALL make a complete Markdown representation available for later continuation

#### Scenario: Transcript is updated

- **WHEN** additional conversation content is committed to an existing tab
- **THEN** the associated transcript SHALL reflect the new content without deleting earlier content

### Requirement: Show prior transcripts when creating a tab

The system SHALL show available prior transcripts for the current workspace in the new-chat flow, including enough identifying information for the user to distinguish them.

#### Scenario: New tab has prior conversations

- **WHEN** the user starts a new tab in a workspace with saved transcripts
- **THEN** the new-chat view SHALL list those transcripts as selectable context sources

#### Scenario: New tab has no prior conversations

- **WHEN** the user starts a new tab in a workspace with no saved transcripts
- **THEN** the new-chat view SHALL remain usable without requiring a transcript selection

### Requirement: Select multiple transcript sources

The system SHALL allow the user to select zero, one, or multiple prior transcripts before starting the new agent conversation.

#### Scenario: User selects transcripts

- **WHEN** the user selects one or more transcript entries
- **THEN** the UI SHALL visibly retain those selections until the new conversation is created or the user removes them

#### Scenario: User clears selections

- **WHEN** the user removes all selected transcript entries
- **THEN** the new conversation SHALL be created without prior transcript context

### Requirement: Transfer selected context to the new agent

The system SHALL include the selected transcripts in the new conversation's initial context in a deterministic order and SHALL preserve each transcript's Markdown content.

#### Scenario: New conversation starts with selected context

- **WHEN** the user creates a new tab with selected transcripts
- **THEN** the new agent SHALL receive an initial context containing each selected transcript and its source identity

#### Scenario: Agent cannot receive an initial prompt

- **WHEN** the selected agent does not support initial context delivery
- **THEN** the system SHALL explain that the context cannot be delivered and SHALL not silently claim that the handoff occurred

### Requirement: Keep transcript handoff workspace-scoped

The system SHALL restrict selectable transcripts to the current workspace and SHALL not expose transcripts from another workspace through the new-chat flow.

#### Scenario: Workspace changes

- **WHEN** the user opens the new-chat flow for a different workspace
- **THEN** only transcripts belonging to that workspace SHALL be listed
