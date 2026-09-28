import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readConversationTranscript,
  transcriptRelativePath,
  writeConversationTranscript,
} from './transcript-files';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('conversation transcript files', () => {
  it('writes and reads a transcript under the workspace metadata directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'emdash-transcript-'));
    temporaryDirectories.push(workspace);

    const relativePath = await writeConversationTranscript(
      workspace,
      'conversation-1',
      '# History'
    );

    expect(relativePath).toBe('.emdash/transcripts/conversation-1.md');
    expect(await readConversationTranscript(workspace, 'conversation-1')).toBe('# History');
    expect(await readFile(join(workspace, relativePath), 'utf8')).toBe('# History');
  });

  it('rejects ids that could escape the workspace', () => {
    expect(() => transcriptRelativePath('../outside')).toThrow('Invalid conversation id');
    expect(() => transcriptRelativePath('conversation/1')).toThrow('Invalid conversation id');
  });
});
