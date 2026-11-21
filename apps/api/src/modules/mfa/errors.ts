export type MfaErrorCode =
  | 'invalid_code'
  | 'setup_not_started'
  | 'access_token_invalid'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable';

const HTTP_STATUS = {
  invalid_code: 400,
  setup_not_started: 409,
  access_token_invalid: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
} as const satisfies Record<MfaErrorCode, number>;

/** MFA kurulum/sifirlama hatalari; Cognito hata adlari burada anlamli HTTP koduna eslenir. */
export class MfaError extends Error {
  readonly code: MfaErrorCode;
  readonly httpStatus: (typeof HTTP_STATUS)[MfaErrorCode];

  constructor(code: MfaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MfaError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}
