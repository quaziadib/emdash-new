import { describe, expect, it } from 'vitest';
import { acpTranscriptMarkdown, ptyTranscriptMarkdown } from './transcript-markdown';

describe('transcript Markdown', () => {
  it('keeps committed ACP messages, tool output, and the active turn in order', () => {
    const markdown = acpTranscriptMarkdown(
      JSON.stringify({
        committed: [
          {
            seq: 0,
            initiator: 'user',
            items: [
              { kind: 'message', role: 'user', text: 'Fix the test' },
              { kind: 'execute-tool-call', title: 'Run tests', outputText: '1 passed' },
              { kind: 'message', role: 'assistant', text: 'Done' },
            ],
            outcome: { kind: 'done' },
          },
        ],
        active: {
          seq: 1,
          initiator: 'agent',
          items: [{ kind: 'message', role: 'assistant', text: 'Continuing' }],
        },
      })
    );
    expect(markdown).toContain('Fix the test');
    expect(markdown).toContain('1 passed');
    expect(markdown.indexOf('Done')).toBeLessThan(markdown.indexOf('Continuing'));
  });

  it('keeps a terminal stream readable and chooses a safe code fence', () => {
    expect(ptyTranscriptMarkdown('before\n```\n\u001b[31mred\u001b[0m')).toContain('````text');
    expect(ptyTranscriptMarkdown('before\u001b[31mred\u001b[0m')).toContain('beforered');
  });
});
