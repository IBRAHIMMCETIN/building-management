import { Construction } from 'lucide-react';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title font-bold">{title}</h1>
      <p className="flex items-center gap-2 text-muted">
        <Construction className="size-5" aria-hidden="true" />
        Bu ekran henüz hazır değil.
      </p>
    </div>
  );
}
