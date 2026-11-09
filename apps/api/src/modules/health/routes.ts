import { Hono } from 'hono';
import type { AppConfig } from '../../app.js';

export function healthRoutes({ version, authMode }: AppConfig) {
  const startedAt = new Date().toISOString();

  return new Hono().get('/', (c) =>
    c.json({
      status: 'ok',
      version,
      startedAt,
      time: new Date().toISOString(),
      ...(authMode ? { authMode } : {}),
    }),
  );
}
