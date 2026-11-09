import { TriangleAlert } from 'lucide-react';
import { env } from '@/config/env';
import { useApiHealth } from '@/hooks/useApiHealth';

/**
 * YALNIZCA yerel gelistirme: web mock token uretirken API baska modda (deny/cognito) ise
 * korumali her istek 401 doner ve kullanici "oturum dongusu" yasar. Bu uyusmazlik ekranin
 * ustunde acikca gosterilir. API production'da kimlik modunu bildirmez; bant hic gorunmez.
 */
export function DevAuthModeBanner() {
  const { data } = useApiHealth();
  if (env.authMode !== 'mock' || !data?.authMode || data.authMode === 'mock') return null;
  return (
    <div role="alert" className="sticky top-0 z-50 flex items-start gap-2 bg-warning px-4 py-2 text-small text-white">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        Web mock modda, ancak API <strong>AUTH_MODE={data.authMode}</strong> ile çalışıyor: tüm korumalı istekler 401 alır ve
        oturum düşer. API'yi <code>AUTH_MODE=mock</code> ile yeniden başlatın.
      </p>
    </div>
  );
}
