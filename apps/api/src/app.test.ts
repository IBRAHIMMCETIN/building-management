import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('API', () => {
  const app = createApp({ version: 'abc1234' });

  it('GET /api/health returns ok with the deployed version', async () => {
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', version: 'abc1234' });
  });

  it('unknown /api routes return JSON 404', async () => {
    const res = await app.request('/api/yok');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
