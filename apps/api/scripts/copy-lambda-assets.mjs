// build:lambda sonrasi: PDF yazi tiplerini Lambda paketine kopyalar (dist/lambda/fonts).
// src/modules/documents/fonts.ts paketten calisirken `./fonts/` altinda arar.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'lambda', 'fonts');
mkdirSync(target, { recursive: true });
for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'OFL.txt']) {
  cpSync(join(root, 'assets', 'fonts', f), join(target, f));
}
console.log(`PDF yazi tipleri kopyalandi: ${target}`);
