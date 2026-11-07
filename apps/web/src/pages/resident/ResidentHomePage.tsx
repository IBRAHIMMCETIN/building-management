import { Card, CardTitle } from '@/components/ui';

export function ResidentHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Hoş geldiniz</h1>
      <Card>
        <CardTitle>Güncel borç</CardTitle>
        <p className="mt-2 text-small text-muted">Borç özeti portal API'sine bağlandığında burada görünecek.</p>
      </Card>
    </div>
  );
}
