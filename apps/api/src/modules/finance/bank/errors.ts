export type BankErrorCode =
  | 'not_found'
  | 'conflict'
  | 'duplicate_file'
  | 'already_committed'
  | 'file_changed'
  | 'version_conflict'
  | 'warnings_unacknowledged'
  | 'unprocessable'
  | 'unsupported_format'
  | 'too_large'
  | 'unavailable'
  | 'storage_error'
  // Faz B2
  | 'account_closed'
  | 'invalid_state';

const HTTP_STATUS = {
  not_found: 404,
  conflict: 409,
  duplicate_file: 409,
  already_committed: 409,
  file_changed: 409,
  version_conflict: 409,
  warnings_unacknowledged: 422,
  unprocessable: 422,
  unsupported_format: 422,
  too_large: 413,
  unavailable: 503,
  storage_error: 502,
  account_closed: 409,
  invalid_state: 409,
} as const satisfies Record<BankErrorCode, number>;

/** Banka ekstresi islemleri hatalari; anlamli HTTP durum koduna eslenir. */
export class BankError extends Error {
  readonly code: BankErrorCode;
  readonly httpStatus: (typeof HTTP_STATUS)[BankErrorCode];
  readonly details?: Record<string, unknown>;

  constructor(code: BankErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BankError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}
