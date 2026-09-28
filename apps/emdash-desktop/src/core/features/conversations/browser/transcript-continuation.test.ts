import { describe, expect, it } from 'vitest';
import {
  buildTranscriptContinuation,
  isMarkdownTranscriptName,
  MAX_TRANSCRIPT_CHARS,
  transcriptSelectionError,
} from './transcript-continuation';

const selection = {
  name: 'claude-session.md',
  text: '  User: fix the login bug.\nAssistant: done.  ',
};

describe('transcript continuation', () => {
  it('accepts markdown transcript names', () => {
    expect(isMarkdownTranscriptName('notes.md')).toBe(true);
    expect(isMarkdownTranscriptName('Notes.MARKDOWN')).toBe(true);
    expect(isMarkdownTranscriptName('transcript.json')).toBe(false);
    expect(isMarkdownTranscriptName('readme.md.txt')).toBe(false);
  });

  it('rejects empty, oversized, and non-markdown files', () => {
    expect(transcriptSelectionError('notes.txt', 'hello')).toBe(
      'Select a markdown transcript (.md).'
    );
    expect(transcriptSelectionError('notes.md', '   ')).toBe('That transcript is empty.');
    expect(transcriptSelectionError('notes.md', 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1))).toBe(
      'That transcript is too large to send.'
    );
    expect(transcriptSelectionError('notes.md', 'hello')).toBeNull();
  });

  it('queues chat context separately from the visible handoff instruction', () => {
    const continuation = buildTranscriptContinuation([selection], 'acp');
    expect(continuation).toMatchObject({
      type: 'acp',
      initialQueue: [
        {
          hiddenContext:
            'Previous transcript (claude-session.md):\n\n' +
            'User: fix the login bug.\nAssistant: done.',
        },
      ],
    });
    if (continuation.type !== 'acp') return;
    const prompt = continuation.initialQueue[0];
    expect(prompt?.text).toContain('claude-session.md');
    expect(prompt?.text).toContain('do not repeat work that is already done.');
    expect(prompt?.hiddenContext?.includes(prompt.text)).toBe(false);
  });

  it('orders and combines multiple transcripts', () => {
    const continuation = buildTranscriptContinuation(
      [selection, { name: 'a-session.md', text: 'Assistant: earlier.' }],
      'pty'
    );
    expect(continuation.type).toBe('pty');
    if (continuation.type !== 'pty') return;
    expect(continuation.initialPrompt.indexOf('a-session.md')).toBeLessThan(
      continuation.initialPrompt.indexOf('claude-session.md')
    );
    expect(continuation.initialPrompt).toContain('Assistant: earlier.');
  });

  it('folds the transcript into the terminal initial prompt', () => {
    const continuation = buildTranscriptContinuation([selection], 'pty');
    expect(continuation.type).toBe('pty');
    if (continuation.type !== 'pty') return;
    expect(continuation.initialPrompt).toContain('claude-session.md');
    expect(continuation.initialPrompt).toContain('User: fix the login bug.');
    expect(continuation.initialPrompt.endsWith('Assistant: done.')).toBe(true);
  });
});
