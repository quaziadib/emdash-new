import { z } from 'zod';

const transcriptItem = z.object({
  kind: z.string(),
  role: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  outputText: z.string().optional(),
  children: z.array(z.unknown()).optional(),
});
const transcriptTurn = z.object({
  seq: z.number(),
  initiator: z.string(),
  items: z.array(z.unknown()),
  outcome: z.object({ kind: z.string() }).optional(),
});
const exportedTranscript = z.object({
  committed: z.array(transcriptTurn),
  active: transcriptTurn.nullable().optional(),
});

function renderItem(value: unknown, depth = 0): string[] {
  const item = transcriptItem.safeParse(value);
  if (!item.success) return [];
  const row = item.data;
  const label = row.kind === 'message' ? (row.role ?? 'Message') : (row.title ?? row.kind);
  const lines = [`${'#'.repeat(Math.min(6, depth + 4))} ${label}`];
  if (row.status) lines.push(`Status: ${row.status}`);
  if (row.text) lines.push(row.text);
  if (row.outputText) lines.push(`Output:\n\n${row.outputText}`);
  for (const child of row.children ?? []) lines.push(...renderItem(child, depth + 1));
  return lines;
}

/** Convert the ACP runtime's complete parsed export into a readable handoff file. */
export function acpTranscriptMarkdown(exported: string): string {
  const parsed = exportedTranscript.parse(JSON.parse(exported));
  const turns = [...parsed.committed, ...(parsed.active ? [parsed.active] : [])];
  return turns
    .map((turn) => {
      const items = turn.items.flatMap((item) => renderItem(item));
      return [
        `## Turn ${turn.seq + 1} (${turn.initiator})`,
        ...items,
        ...(turn.outcome ? [`Outcome: ${turn.outcome.kind}`] : []),
      ].join('\n\n');
    })
    .join('\n\n');
}

/** Terminal output is a stream, so preserve its complete observed text in a fenced block. */
export function ptyTranscriptMarkdown(output: string): string {
  const sanitized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const fence = '`'.repeat(
    Math.max(3, ...(sanitized.match(/`+/g) ?? []).map((run) => run.length + 1))
  );
  return `# Terminal conversation\n\n${fence}text\n${sanitized}\n${fence}\n`;
}
