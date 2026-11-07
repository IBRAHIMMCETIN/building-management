import { type ReactElement, cloneElement, useId } from 'react';

type FieldControlProps = {
  id?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
};

type FormFieldProps = {
  label: string;
  error?: string;
  hint?: string;
  children: ReactElement<FieldControlProps>;
};

/** Etiket + kontrol + hata metnini erisilebilir sekilde baglar (react-hook-form ile). */
export function FormField({ label, error, hint, children }: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-msg`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-text">
        {label}
      </label>
      {cloneElement(children, {
        id,
        invalid: Boolean(error),
        'aria-describedby': message ? messageId : undefined,
      })}
      {message && (
        <p id={messageId} className={error ? 'text-small text-danger' : 'text-small text-muted'}>
          {message}
        </p>
      )}
    </div>
  );
}
