import * as z from 'zod/v4';

export const idSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const text = z.string().min(1).max(4000);

export const startSchema = z.object({
  scope: z.enum(['staged', 'worktree', 'commits']).default('staged'),
  base: text.optional(),
  head: text.optional(),
  includeUntracked: z.array(text).max(200).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  requestId: idSchema.optional().describe('Optional idempotency UUID. Reuse it when retrying an uncertain start; changing its request is an error.'),
}).strict().superRefine((input, ctx) => {
  if (input.scope === 'commits' && (!input.base || !input.head)) ctx.addIssue({ code: 'custom', message: 'Commit scope requires base and head' });
  if (input.scope !== 'commits' && (input.base !== undefined || input.head !== undefined)) ctx.addIssue({ code: 'custom', message: 'Commit refs require commit scope' });
  if (input.scope !== 'worktree' && input.includeUntracked !== undefined) ctx.addIssue({ code: 'custom', message: 'Explicit untracked files require worktree scope' });
});
export type StartRequest = z.input<typeof startSchema>;
export const getSchema = z.object({ id: idSchema.describe('taskId from start_review, or an existing native runId'), includeReport: z.boolean().default(true) }).strict();
export const evidenceSchema = z.object({ runId: idSchema, findingId: text, evidenceIndex: z.number().int().min(0).max(19).default(0) }).strict();
export const listSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) }).strict();
export const cancelSchema = z.object({ taskId: idSchema }).strict();

/** Only these deliberately authored errors can cross the MCP boundary. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
