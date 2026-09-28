import { and, desc, eq } from 'drizzle-orm';
import type { ConversationTranscript } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { conversationTranscripts } from '@core/services/app-db/node/schema';

export type ConversationTranscriptMetadata = Omit<ConversationTranscript, 'content'>;

export function listConversationTranscriptMetadata(
  db: AppDb,
  projectId: string
): ConversationTranscriptMetadata[] {
  return db
    .select()
    .from(conversationTranscripts)
    .where(eq(conversationTranscripts.projectId, projectId))
    .orderBy(desc(conversationTranscripts.updatedAt))
    .all();
}

export function getConversationTranscriptMetadata(
  db: AppDb,
  projectId: string,
  conversationId: string
): ConversationTranscriptMetadata | null {
  return (
    db
      .select()
      .from(conversationTranscripts)
      .where(
        and(
          eq(conversationTranscripts.projectId, projectId),
          eq(conversationTranscripts.conversationId, conversationId)
        )
      )
      .get() ?? null
  );
}

export function findConversationTranscriptMetadata(
  db: AppDb,
  conversationId: string
): ConversationTranscriptMetadata | null {
  return (
    db
      .select()
      .from(conversationTranscripts)
      .where(eq(conversationTranscripts.conversationId, conversationId))
      .get() ?? null
  );
}

export function upsertConversationTranscriptMetadata(
  db: AppDb,
  metadata: ConversationTranscriptMetadata
): void {
  db.insert(conversationTranscripts)
    .values(metadata)
    .onConflictDoUpdate({
      target: conversationTranscripts.conversationId,
      set: {
        projectId: metadata.projectId,
        workspacePath: metadata.workspacePath,
        title: metadata.title,
        relativePath: metadata.relativePath,
        updatedAt: metadata.updatedAt,
      },
    })
    .run();
}

export function deleteConversationTranscriptMetadata(db: AppDb, conversationId: string): void {
  db.delete(conversationTranscripts)
    .where(eq(conversationTranscripts.conversationId, conversationId))
    .run();
}
