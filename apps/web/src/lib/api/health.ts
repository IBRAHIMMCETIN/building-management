import { z } from 'zod';
import { apiClient } from './client';

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  startedAt: z.string(),
  time: z.string(),
  /** Yalnizca yerel API: kimlik modu (cognito | apigw | mock | deny). */
  authMode: z.string().optional(),
});

export type Health = z.infer<typeof healthSchema>;

export const fetchHealth = (signal?: AbortSignal) =>
  apiClient.get('/api/health', { auth: false, signal, schema: healthSchema });
