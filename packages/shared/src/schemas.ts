import { z } from 'zod';

export const viewportSchema = z.object({
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});

export const settleSchema = z.object({
  waitUntil: z.enum(['networkidle0', 'networkidle2', 'load', 'domcontentloaded']).optional(),
  selector: z.string().min(1).max(512).optional(),
  mutationQuietMs: z.number().int().nonnegative().max(30_000).optional(),
  maxWaitMs: z.number().int().positive().max(60_000).optional(),
});

export const authPayloadSchema = z.object({
  kind: z.enum(['impersonation', 'session']),
  value: z.string().min(1).max(32_768),
});

export const captureRequestSchema = z.object({
  productId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  userId: z.string().min(1).max(256),
  url: z.string().url().max(4096),
  viewport: viewportSchema.optional(),
  settle: settleSchema.optional(),
  auth: authPayloadSchema,
});

export type CaptureRequestInput = z.infer<typeof captureRequestSchema>;
