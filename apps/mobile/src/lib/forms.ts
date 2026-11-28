import type { z } from 'zod';

/** zod sonucundan alan bazli ilk hata mesaji (web'de react-hook-form + zodResolver'in karsiligi). */
export function fieldErrors<T>(result: z.ZodSafeParseResult<T>): Partial<Record<string, string>> {
  if (result.success) return {};
  const out: Partial<Record<string, string>> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
