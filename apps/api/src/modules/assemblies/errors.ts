import type { IsoDate } from '../core/types.js';
import { PollError } from '../polls/errors.js';

/** Hata kodlari anket / oylama ile ortak (Y1). */
export class AssemblyError extends PollError {
  override name = 'AssemblyError';
}

/** Iki Istanbul takvim gunu arasi gun sayisi (`to - from`). */
export const dayDiff = (from: IsoDate, to: IsoDate) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
