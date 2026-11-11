export type DocumentErrorCode = 'not_found' | 'unprocessable' | 'unavailable' | 'storage_error';

const HTTP_STATUS = {
  not_found: 404,
  unprocessable: 422,
  unavailable: 503,
  storage_error: 502,
} as const satisfies Record<DocumentErrorCode, number>;

/** Belge/dosya islemleri hatalari (S3, PDF). Anlamli HTTP durum koduna eslenir. */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly httpStatus: (typeof HTTP_STATUS)[DocumentErrorCode];

  constructor(code: DocumentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}
