/**
 * Giris/sifre akisi hatasi. Cognito (Amplify) hata adlari kullaniciya gosterilecek
 * Turkce mesajlara burada cevrilir; ham hata ayrintisi arayuze sizmaz.
 */
export class AuthFlowError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'E-posta veya şifre hatalı.',
  // prevent_user_existence_errors = ENABLED: Cognito cogunlukla NotAuthorized doner; yine de esleyelim.
  UserNotFoundException: 'E-posta veya şifre hatalı.',
  UserNotConfirmedException: 'Hesabınız henüz doğrulanmamış. Yöneticinizle iletişime geçin.',
  PasswordResetRequiredException: 'Şifrenizin sıfırlanması gerekiyor.',
  CodeMismatchException: 'Kod hatalı. Lütfen kontrol edip tekrar deneyin.',
  ExpiredCodeException: 'Kodun süresi dolmuş. Yeni kod isteyin.',
  InvalidPasswordException: 'Şifre, güvenlik kurallarını karşılamıyor.',
  LimitExceededException: 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.',
  TooManyRequestsException: 'Çok fazla istek gönderildi. Bir süre sonra tekrar deneyin.',
  TooManyFailedAttemptsException: 'Çok fazla hatalı deneme. Bir süre sonra tekrar deneyin.',
  EnableSoftwareTokenMFAException: 'Doğrulama kodu hatalı.',
  InvalidParameterException: 'Girilen bilgiler geçersiz.',
  NetworkError: 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.',
  // Amplify: challenge oturumu (3 dk) dolmus veya sayfa yenilenmis.
  SignInException: 'Giriş oturumu zaman aşımına uğradı. Lütfen baştan giriş yapın.',
};

export function toAuthFlowError(err: unknown): AuthFlowError {
  if (err instanceof AuthFlowError) return err;
  const name = err instanceof Error ? err.name : 'Unknown';
  if (name === 'NotAuthorizedException' && err instanceof Error && /session/i.test(err.message)) {
    return new AuthFlowError(name, MESSAGES.SignInException as string, err);
  }
  return new AuthFlowError(name, MESSAGES[name] ?? 'Beklenmeyen bir hata oluştu. Tekrar deneyin.', err);
}
