import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './errors';

/**
 * API dogrulama hatasini (400 + `field`) ilgili form alanina yazar. Alan formda yoksa
 * false doner; cagiran genel hata kutusunu gosterir. `fieldMap` API alan adini form
 * alanina esler (ornek: landShare -> landShareNumerator).
 */
export function applyApiFieldError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
  fieldMap: Partial<Record<string, Path<T>>> = {},
): boolean {
  if (!(err instanceof ApiError) || err.status !== 400 || !err.field) return false;
  const target = fieldMap[err.field] ?? (fields.includes(err.field as Path<T>) ? (err.field as Path<T>) : undefined);
  if (!target) return false;
  setError(target, { type: 'server', message: err.message }, { shouldFocus: true });
  return true;
}
