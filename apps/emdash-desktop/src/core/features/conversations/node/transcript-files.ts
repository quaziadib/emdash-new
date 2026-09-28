import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const TRANSCRIPT_DIRECTORY = '.emdash/transcripts';
const SAFE_CONVERSATION_ID = /^[a-zA-Z0-9._-]+$/;

export function transcriptRelativePath(conversationId: string): string {
  if (!SAFE_CONVERSATION_ID.test(conversationId)) {
    throw new Error('Invalid conversation id for transcript path.');
  }
  return join(TRANSCRIPT_DIRECTORY, `${conversationId}.md`);
}

function transcriptPath(workspacePath: string, conversationId: string): string {
  const root = resolve(workspacePath);
  const path = resolve(root, transcriptRelativePath(conversationId));
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || resolve(root, relativePath) !== path) {
    throw new Error('Transcript path escapes the workspace.');
  }
  return path;
}

export async function writeConversationTranscript(
  workspacePath: string,
  conversationId: string,
  content: string
): Promise<string> {
  const path = transcriptPath(workspacePath, conversationId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return transcriptRelativePath(conversationId);
}

export async function readConversationTranscript(
  workspacePath: string,
  conversationId: string
): Promise<string> {
  return readFile(transcriptPath(workspacePath, conversationId), 'utf8');
}
