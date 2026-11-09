import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PASSWORD_RULES } from './schemas';

/** Yeni sifre yazilirken Cognito parola kurallarini canli gosterir. */
export function PasswordRules({ value }: { value: string }) {
  return (
    <ul aria-label="Şifre kuralları" className="grid grid-cols-1 gap-x-3 gap-y-1 text-small min-[400px]:grid-cols-2">
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(value);
        return (
          <li key={rule.label} className={cn('flex items-center gap-1.5', ok ? 'text-success' : 'text-muted')}>
            {ok ? <Check className="size-3.5" aria-hidden="true" /> : <Circle className="size-3.5" aria-hidden="true" />}
            <span>
              {rule.label}
              <span className="sr-only">{ok ? ' (sağlandı)' : ' (eksik)'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
