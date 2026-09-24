// Structured outputs the agent returns via SDK outputFormat (DESIGN §5.5, §7.3).
// One zod source of truth: z.toJSONSchema() feeds the SDK, the same schema parses the result.
import { z } from 'zod';

const item = z.object({
  url: z.string().describe('Comment or thread URL'),
  severity: z.enum(['Critical', 'Suggestion', 'Information', '-']),
  action: z.enum(['fix', 'reply', 'escalate', 'ignore']),
  commit: z.string().nullable().describe('Commit SHA when action=fix, else null'),
  note: z.string(),
});

export const nextSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('request_review'),
    reviewers: z.array(z.string()).min(1),
    summary: z.string().describe('Natural-language round summary, ≤5 lines (DESIGN §6.3)'),
    resend: z.boolean().describe('true = re-send after a stalled/errored request; does not count a round'),
  }),
  z.object({
    action: z.literal('request_approve'),
    approvers: z.array(z.string()).optional().describe('Subset of configured approvers to ask; omit to ask all of them'),
  }),
  z.object({ action: z.literal('merge'), sha: z.string().min(7), title: z.string() }),
  z.object({ action: z.literal('wait'), minutes: z.number().int().min(1).max(60), reason: z.string() }),
  z.object({ action: z.literal('escalate'), reason: z.string() }),
  z.object({ action: z.literal('done'), reason: z.string() }),
]);

export const shepherdOutputSchema = z.object({
  handled: z.array(z.object({ reviewer: z.string(), review_url: z.string(), items: z.array(item) })),
  rebase: z.object({ onto: z.string(), conflicts: z.array(z.string()), note: z.string() }).nullable(),
  status_line: z.string().describe('One line for `status` and the daily report'),
  next: nextSchema,
});

export const reviewOutputSchema = z.object({
  round: z.number().int().min(1),
  head_sha: z.string(),
  verdict: z.enum(['approved', 'request_changes']),
  counts: z.object({ critical: z.number().int(), suggestion: z.number().int(), information: z.number().int() }),
  summary: z.string(),
  verified: z.string().describe('What was run and the results; what could not be run and why'),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().min(1),
      severity: z.enum(['Critical', 'Suggestion', 'Information']),
      body: z.string(),
    }),
  ),
});

export type ShepherdOutput = z.infer<typeof shepherdOutputSchema>;
export type Next = z.infer<typeof nextSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

// The Claude CLI rejects the draft-2020-12 `$schema` URI zod emits, so strip it (verified 2026-09-23).
function forSdk(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const shepherdJsonSchema = forSdk(shepherdOutputSchema);
export const reviewJsonSchema = forSdk(reviewOutputSchema);
