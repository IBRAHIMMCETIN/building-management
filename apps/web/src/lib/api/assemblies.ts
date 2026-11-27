import { z } from 'zod';
import {
  type AssemblyInput,
  type AttendanceInput,
  type MinutesInput,
  type TallyInput,
  assemblyDetailSchema,
  assemblySchema,
  callResultSchema,
  decisionSchema,
  portalAssemblySchema,
  quorumSchema,
} from './assemblyModel';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

export * from './assemblyModel';

const base = '/api/assemblies';
const portal = '/api/portal/assemblies';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
const withQuorum = z.object({ assembly: assemblySchema, quorum: quorumSchema });
const pdf = signedDownloadSchema.extend({ preview: z.boolean() });

export const assembliesApi = {
  list: (signal?: AbortSignal) => apiClient.get(base, { signal, schema: z.object({ items: z.array(assemblySchema) }) }),
  create: (input: AssemblyInput) => apiClient.post(base, input, { schema: assemblySchema }),
  update: (id: string, input: AssemblyInput & { version: number }) => apiClient.patch(one(id), input, { schema: assemblySchema }),
  detail: (id: string, signal?: AbortSignal) => apiClient.get(one(id), { signal, schema: assemblyDetailSchema }),
  /** Cagri e-postasi; ilk gonderimden sonra `resend: true` + gerekce. 15 gun kuralina uyulmadiysa `warnings`. */
  call: (id: string, input: { version: number; resend?: boolean; reason?: string }) => apiClient.post(`${one(id)}/call`, input, { schema: callResultSchema }),
  attendance: (id: string, unitId: string, input: AttendanceInput) =>
    apiClient.put(`${one(id)}/attendance/${encodeURIComponent(unitId)}`, input, { schema: z.object({ attendance: z.object({ mode: z.string() }).passthrough() }) }),
  /** `noAttendance`: toplantiya kimse gelmedi (katilim kaydi yokken yeter sayisizlik tutanagi). */
  recordQuorum: (id: string, version: number, noAttendance = false) =>
    apiClient.post(`${one(id)}/quorum`, { version, ...(noAttendance ? { noAttendance } : {}) }, { schema: withQuorum }),
  /** Karar: oy sayilari (katilanlarin cogunlugu) veya bolum bazinda oy; kayitli karar yalnizca `correctionReason` ile duzeltilir. */
  tally: (id: string, itemId: string, input: TallyInput) =>
    apiClient.post(`${one(id)}/agenda/${encodeURIComponent(itemId)}/tally`, input, { schema: withQuorum.extend({ decision: decisionSchema }) }),
  minutes: (id: string, input: MinutesInput) => apiClient.put(`${one(id)}/minutes`, input, { schema: assemblySchema }),
  finalize: (id: string, version: number) => apiClient.post(`${one(id)}/finalize`, { version }, { schema: z.object({ assembly: assemblySchema, warnings: z.array(z.string()) }) }),
  cancel: (id: string, version: number, reason: string) => apiClient.post(`${one(id)}/cancel`, { version, reason }, { schema: assemblySchema }),
  /** Hazirun: oy listesi dondurulmadiysa `preview: true` (on izleme; okuma hicbir sey dondurmaz). */
  attendanceSheet: (id: string) => apiClient.get(`${one(id)}/attendance-sheet`, { schema: pdf }),
  /** Tutanak: kesinlesmediyse `preview: true` (taslak). */
  minutesPdf: (id: string) => apiClient.get(`${one(id)}/minutes`, { schema: pdf }),
  decisionBook: () => apiClient.get(`${base}/decision-book`, { schema: signedDownloadSchema }),

  portalList: (signal?: AbortSignal) => apiClient.get(portal, { signal, schema: z.object({ items: z.array(portalAssemblySchema) }) }),
  portalGet: (id: string, signal?: AbortSignal) => apiClient.get(`${portal}/${encodeURIComponent(id)}`, { signal, schema: portalAssemblySchema }),
  portalMinutes: (id: string) => apiClient.get(`${portal}/${encodeURIComponent(id)}/minutes`, { schema: signedDownloadSchema }),
};
