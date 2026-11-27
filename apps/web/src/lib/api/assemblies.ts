import { z } from 'zod';
import { type AssemblyInput, type AttendanceMode, assemblyDetailSchema, assemblySchema, quorumSchema } from './assemblyModel';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

export * from './assemblyModel';

const base = '/api/assemblies';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const assembliesApi = {
  list: (signal?: AbortSignal) => apiClient.get(base, { signal, schema: z.object({ items: z.array(assemblySchema) }) }),
  create: (input: AssemblyInput) => apiClient.post(base, input, { schema: assemblySchema }),
  update: (id: string, input: AssemblyInput & { version: number }) => apiClient.patch(one(id), input, { schema: assemblySchema }),
  detail: (id: string, signal?: AbortSignal) => apiClient.get(one(id), { signal, schema: assemblyDetailSchema }),
  attendance: (id: string, unitId: string, input: { mode: AttendanceMode; attendeeName?: string; proxyName?: string }) =>
    apiClient.put(`${one(id)}/attendance/${encodeURIComponent(unitId)}`, input, { schema: z.object({ attendance: z.object({ mode: z.string() }).passthrough() }) }),
  tally: (id: string, itemId: string, input: { version: number; yes: number; no: number; abstain: number }) =>
    apiClient.post(`${one(id)}/agenda/${encodeURIComponent(itemId)}/tally`, input, { schema: z.object({ assembly: assemblySchema, quorum: quorumSchema }) }),
  cancel: (id: string, version: number, reason: string) => apiClient.post(`${one(id)}/cancel`, { version, reason }, { schema: assemblySchema }),
  attendanceSheet: (id: string) => apiClient.get(`${one(id)}/attendance-sheet`, { schema: signedDownloadSchema }),
};
