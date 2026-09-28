CREATE TABLE `conversation_transcripts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`title` text NOT NULL,
	`relative_path` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_transcripts_project_updated_at` ON `conversation_transcripts` (`project_id`,`updated_at`);