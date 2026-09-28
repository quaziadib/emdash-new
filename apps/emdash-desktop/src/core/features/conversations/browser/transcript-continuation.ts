import type { ConversationType, InitialQueuePrompt } from '@core/primitives/conversations/api';

/** Keep a handoff transcript small enough to store on the conversation and send once. */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

export type TranscriptSelection = {
  name: string;
  text: string;
};

export type TranscriptContinuation =
  | { type: 'acp'; initialQueue: InitialQueuePrompt[] }
  | { type: 'pty'; initialPrompt: string };

export function isMarkdownTranscriptName(name: string): boolean {
  return MARKDOWN_EXTENSION.test(name);
}

export function transcriptSelectionError(name: string, text: string): string | null {
  if (!isMarkdownTranscriptName(name)) {
    return 'Select a markdown transcript (.md).';
  }
  if (!text.trim()) return 'That transcript is empty.';
  if (text.length > MAX_TRANSCRIPT_CHARS) return 'That transcript is too large to send.';
  return null;
}

/**
 * Turns a previous-agent markdown transcript into the one-shot prompt a new chat
 * or terminal session receives on first start.
 */
export function buildTranscriptContinuation(
  selections: readonly TranscriptSelection[],
  type: ConversationType
): TranscriptContinuation {
  const ordered = [...selections].sort((left, right) => left.name.localeCompare(right.name));
  const names = ordered.map((selection) => `"${selection.name}"`).join(', ');
  const instruction = [
    `Continue the previous agent work using these transcripts: ${names}.`,
    'Treat that transcript as prior context, pick up unfinished work,',
    'and do not repeat work that is already done.',
  ].join(' ');
  const transcript = ordered
    .map((selection) => `Previous transcript (${selection.name}):\n\n${selection.text.trim()}`)
    .join('\n\n---\n\n');
  if (type === 'acp') {
    return { type: 'acp', initialQueue: [{ text: instruction, hiddenContext: transcript }] };
  }
  return { type: 'pty', initialPrompt: `${instruction}\n\n${transcript}` };
}
