/** Toplu is uclarinin hatasi (404 / 409 / 422). */
export class BulkJobError extends Error {
  readonly code: 'not_found' | 'conflict' | 'unprocessable';
  readonly httpStatus: 404 | 409 | 422;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: BulkJobError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BulkJobError';
    this.code = code;
    this.httpStatus = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
    this.details = details;
  }
}
