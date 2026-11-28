import { z } from 'zod';
import {
  type AssemblyInput,
  type AttendanceInput,
  type ConsentEntryInput,
  type ConsentInput,
  type MinutesInput,
  type RescheduleInput,
  type ServiceAttemptInput,
  type ServiceUpdateInput,
  type TallyInput,
  assemblyDetailSchema,
  assemblySchema,
  callResultSchema,
  consentCreatedSchema,
  consentDetailSchema,
  consentRecordSchema,
  consentSchema,
  decisionSchema,
  outcomeSchema,
  portalAssemblySchema,
  quorumSchema,
  rescheduleResultSchema,
  serviceAttemptSchema,
  serviceReportSchema,
} from './assemblyModel';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

export * from './assemblyModel';

const base = '/api/assemblies';
const portal = '/api/portal/assemblies';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
const withQuorum = z.object({ assembly: assemblySchema, quorum: quorumSchema });
const pdf = signedDownloadSchema.extend({ preview: z.boolean() });
const consentOne = (cid: string) => `${base}/consents/${encodeURIComponent(cid)}`;
const serviceRecord = z.object({ record: z.object({ ownerId: z.string(), attempts: z.array(serviceAttemptSchema), version: z.number().int() }).passthrough() });

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
  /** Cagrisi gonderilmis toplantinin ertelenmesi / yer degisikligi: tum cagri alicilarina bildirim gider. */
  reschedule: (id: string, input: RescheduleInput) => apiClient.post(`${one(id)}/reschedule`, input, { schema: rescheduleResultSchema }),
  /** Yasal cagri (KMK m.29) teslim takibi; `unserved`: tebligat yapilmamis malikler. */
  serviceReport: (id: string, unserved = false, signal?: AbortSignal) =>
    apiClient.get(`${one(id)}/service`, { signal, query: unserved ? { filter: 'unserved' } : undefined, schema: serviceReportSchema }),
  addServiceAttempt: (id: string, ownerId: string, input: ServiceAttemptInput) => apiClient.post(`${one(id)}/service/${encodeURIComponent(ownerId)}`, input, { schema: serviceRecord }),
  updateServiceAttempt: (id: string, ownerId: string, seq: number, input: ServiceUpdateInput) =>
    apiClient.patch(`${one(id)}/service/${encodeURIComponent(ownerId)}/${seq}`, input, { schema: serviceRecord }),
  /** Hazirun: oy listesi dondurulmadiysa `preview: true` (on izleme; okuma hicbir sey dondurmaz). */
  attendanceSheet: (id: string) => apiClient.get(`${one(id)}/attendance-sheet`, { schema: pdf }),
  /** Tutanak: kesinlesmediyse `preview: true` (taslak). */
  minutesPdf: (id: string) => apiClient.get(`${one(id)}/minutes`, { schema: pdf }),
  decisionBook: () => apiClient.get(`${base}/decision-book`, { schema: signedDownloadSchema }),

  /** Toplanti disinda yazili riza talepleri (KMK m.19/2 ve README "Hukuki yorum"). */
  consents: (signal?: AbortSignal) => apiClient.get(`${base}/consents`, { signal, schema: z.object({ items: z.array(consentSchema) }) }),
  createConsent: (input: ConsentInput) => apiClient.post(`${base}/consents`, input, { schema: consentCreatedSchema }),
  consent: (cid: string, signal?: AbortSignal) => apiClient.get(consentOne(cid), { signal, schema: consentDetailSchema }),
  /** Bolumun riza / itiraz kaydi (degismez); kayitli bolumde yalnizca `correctionReason` ile yeni kayit. */
  recordConsent: (cid: string, unitId: string, input: ConsentEntryInput) => apiClient.put(`${consentOne(cid)}/units/${encodeURIComponent(unitId)}`, input, { schema: consentRecordSchema }),
  closeConsent: (cid: string, version: number) => apiClient.post(`${consentOne(cid)}/close`, { version }, { schema: z.object({ consent: consentSchema, outcome: outcomeSchema }) }),
  cancelConsent: (cid: string, version: number, reason: string) => apiClient.post(`${consentOne(cid)}/cancel`, { version, reason }, { schema: z.object({ consent: consentSchema }) }),
  consentPdf: (cid: string) => apiClient.get(`${consentOne(cid)}/pdf`, { schema: signedDownloadSchema.extend({ interim: z.boolean() }) }),
  consentDocument: (cid: string, unitId: string) => apiClient.get(`${consentOne(cid)}/units/${encodeURIComponent(unitId)}/document`, { schema: signedDownloadSchema }),

  portalList: (signal?: AbortSignal) => apiClient.get(portal, { signal, schema: z.object({ items: z.array(portalAssemblySchema) }) }),
  portalGet: (id: string, signal?: AbortSignal) => apiClient.get(`${portal}/${encodeURIComponent(id)}`, { signal, schema: portalAssemblySchema }),
  portalMinutes: (id: string) => apiClient.get(`${portal}/${encodeURIComponent(id)}/minutes`, { schema: signedDownloadSchema }),
};
