import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { err, ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTranscript, removeTranscript, saveTranscript } from './transcript-store';

const metadata = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('./transcript-repository', () => ({
  getConversationTranscriptMetadata: metadata.get,
  upsertConversationTranscriptMetadata: metadata.upsert,
  deleteConversationTranscriptMetadata: metadata.remove,
}));

const location = {
  conversationId: 'conversation-1',
  projectId: 'project-1',
  workspacePath: '/workspace',
  title: 'Claude conversation',
  host: LOCAL_HOST_REF,
};

function runtime() {
  const createDirectory = vi.fn(async () => ok(undefined));
  const createFile = vi.fn(async () => ok(undefined));
  const writeFile = vi.fn(async () => ok(undefined));
  const readText = vi.fn(async () =>
    ok({ content: '# Full transcript', truncated: false, totalSize: 17, etag: 'etag' })
  );
  const deleteFile = vi.fn(async () => ok(undefined));
  const client = vi.fn(async () =>
    ok({ files: { fs: { createDirectory, createFile, writeFile, readText, delete: deleteFile } } })
  );
  return {
    broker: { client } as never,
    createDirectory,
    createFile,
    writeFile,
    readText,
    deleteFile,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  metadata.get.mockReturnValue({
    ...location,
    relativePath: '.emdash/transcripts/conversation-1.md',
  });
});

describe('workspace transcript storage', () => {
  it('writes the complete content through the host file runtime before updating metadata', async () => {
    const host = runtime();
    const content = 'A'.repeat(1_100_000);
    await saveTranscript({} as never, host.broker, location, content);
    expect(host.createDirectory).toHaveBeenCalledTimes(2);
    expect(host.createFile).toHaveBeenCalledOnce();
    expect(host.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ content, precondition: { kind: 'overwrite' } })
    );
    expect(metadata.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: location.conversationId, title: location.title })
    );
    expect(host.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      metadata.upsert.mock.invocationCallOrder[0]!
    );
    expect(host.createFile.mock.invocationCallOrder[0]).toBeLessThan(
      host.writeFile.mock.invocationCallOrder[0]!
    );
  });

  it('loads full content and removes file before metadata', async () => {
    const host = runtime();
    await expect(loadTranscript({} as never, host.broker, location)).resolves.toBe(
      '# Full transcript'
    );
    expect(host.readText).toHaveBeenCalledWith(
      expect.objectContaining({ options: { maxBytes: Number.MAX_SAFE_INTEGER } })
    );
    await removeTranscript({} as never, host.broker, location);
    expect(host.deleteFile).toHaveBeenCalledOnce();
    expect(metadata.remove).toHaveBeenCalledWith(expect.anything(), location.conversationId);
  });

  it('updates an existing transcript after file creation reports already-exists', async () => {
    const host = runtime();
    host.createFile.mockResolvedValueOnce(err({ type: 'already-exists' }) as never);
    await saveTranscript({} as never, host.broker, location, '# Updated');
    expect(host.writeFile).toHaveBeenCalledWith(expect.objectContaining({ content: '# Updated' }));
    expect(metadata.upsert).toHaveBeenCalledOnce();
  });

  it('does not write metadata when the workspace file cannot be created', async () => {
    const host = runtime();
    host.createFile.mockResolvedValueOnce(err({ type: 'not-found' }) as never);
    await expect(saveTranscript({} as never, host.broker, location, '# Message')).rejects.toThrow(
      'Transcript file creation failed: not-found'
    );
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(metadata.upsert).not.toHaveBeenCalled();
  });

  it('refuses metadata pointing at another workspace', async () => {
    const host = runtime();
    metadata.get.mockReturnValue({ ...location, workspacePath: '/another-workspace' });
    await expect(loadTranscript({} as never, host.broker, location)).resolves.toBeNull();
    expect(host.readText).not.toHaveBeenCalled();
  });
});
