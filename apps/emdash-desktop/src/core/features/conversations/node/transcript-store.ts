import type { HostRef } from '@emdash/core/primitives/host/api';
import type { ConversationsRuntimeBroker } from '@core/features/conversations/api/runtime-adapter';
import { portablePath, resolveRelativePath } from '@core/primitives/desktop-runtime/api';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  fileKey,
  filesClientScope,
  fsErrorMessage,
} from '@core/services/runtime-broker/node/files';
import { transcriptRelativePath } from './transcript-files';
import {
  deleteConversationTranscriptMetadata,
  getConversationTranscriptMetadata,
  upsertConversationTranscriptMetadata,
} from './transcript-repository';

type TranscriptLocation = {
  conversationId: string;
  projectId: string;
  workspacePath: string;
  title: string;
  host: HostRef;
};

function failed(operation: string, error: { type: string; message?: string }): Error {
  return new Error(`Transcript ${operation} failed: ${error.message ?? error.type}`);
}

export async function saveTranscript(
  db: AppDb,
  runtimes: ConversationsRuntimeBroker,
  location: TranscriptLocation,
  content: string
): Promise<void> {
  if (!content.trim()) return;
  const connection = await runtimes.client(location.host);
  if (!connection.success) throw failed('host access', connection.error);
  const relativePath = transcriptRelativePath(location.conversationId);
  const scope = filesClientScope(connection.data.files, location.workspacePath);
  for (const directoryName of ['.emdash', '.emdash/transcripts']) {
    const directory = resolveRelativePath(scope.root, portablePath(directoryName));
    const created = await scope.client.fs.createDirectory(fileKey(scope, directory));
    if (!created.success && created.error.type !== 'already-exists') {
      throw failed('directory creation', created.error);
    }
  }
  const transcriptFile = fileKey(
    scope,
    resolveRelativePath(scope.root, portablePath(relativePath))
  );
  const created = await scope.client.fs.createFile(transcriptFile);
  if (!created.success && created.error.type !== 'already-exists') {
    throw failed('file creation', created.error);
  }
  const written = await scope.client.fs.writeFile({
    ...transcriptFile,
    content,
    precondition: { kind: 'overwrite' },
  });
  if (!written.success) throw failed('write', written.error);
  upsertConversationTranscriptMetadata(db, {
    conversationId: location.conversationId,
    projectId: location.projectId,
    workspacePath: location.workspacePath,
    title: location.title,
    relativePath,
    updatedAt: new Date().toISOString(),
  });
}

export async function loadTranscript(
  db: AppDb,
  runtimes: ConversationsRuntimeBroker,
  location: TranscriptLocation
): Promise<string | null> {
  const metadata = getConversationTranscriptMetadata(
    db,
    location.projectId,
    location.conversationId
  );
  if (!metadata || metadata.workspacePath !== location.workspacePath) return null;
  const connection = await runtimes.client(location.host);
  if (!connection.success) throw failed('host access', connection.error);
  const scope = filesClientScope(connection.data.files, location.workspacePath);
  // The path comes from the conversation id, never from renderer input or mutable metadata.
  const path = resolveRelativePath(
    scope.root,
    portablePath(transcriptRelativePath(location.conversationId))
  );
  const read = await scope.client.fs.readText({
    ...fileKey(scope, path),
    options: { maxBytes: Number.MAX_SAFE_INTEGER },
  });
  if (!read.success) {
    if (read.error.type === 'not-found') return null;
    throw new Error(`Transcript read failed: ${fsErrorMessage(read.error)}`);
  }
  if (read.data.truncated) throw new Error('Transcript read was truncated.');
  return read.data.content;
}

export async function removeTranscript(
  db: AppDb,
  runtimes: ConversationsRuntimeBroker,
  location: TranscriptLocation
): Promise<void> {
  const metadata = getConversationTranscriptMetadata(
    db,
    location.projectId,
    location.conversationId
  );
  if (!metadata) return;
  const connection = await runtimes.client(location.host);
  if (!connection.success) throw failed('host access', connection.error);
  const scope = filesClientScope(connection.data.files, metadata.workspacePath);
  const path = resolveRelativePath(
    scope.root,
    portablePath(transcriptRelativePath(location.conversationId))
  );
  const deleted = await scope.client.fs.delete(fileKey(scope, path));
  if (!deleted.success && deleted.error.type !== 'not-found') {
    throw failed('delete', deleted.error);
  }
  deleteConversationTranscriptMetadata(db, location.conversationId);
}
