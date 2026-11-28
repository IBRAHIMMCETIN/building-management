import { NetworkError } from '@bm/shared/api/errors';

export const OFFLINE_MESSAGE = 'Çevrimdışısınız: işlem gönderilmedi. Bağlantı gelince tekrar deneyin.';

/**
 * Cihaz cevrimdisiyken yazan istek (POST / PUT / PATCH / DELETE) hic gonderilmez. `NetworkError`'dan
 * turer: ag hatasi gibi ele alinir (oturum korunur, ekranda `errorMessage` ile bu metin gorunur).
 */
export class OfflineError extends NetworkError {
  constructor() {
    super(undefined);
    this.name = 'OfflineError';
    this.message = OFFLINE_MESSAGE;
  }
}
