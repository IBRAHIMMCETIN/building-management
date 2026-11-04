// Build ciktilarini EC2'ya gidecek tek klasorde toplar:
//   release/server.mjs   (bundle edilmis API + statik sunucu)
//   release/public/      (React build)
import { cpSync, existsSync, rmSync } from 'node:fs';

const out = 'release';
const inputs = [
  ['apps/api/dist/server.mjs', `${out}/server.mjs`],
  ['apps/web/dist', `${out}/public`],
];

for (const [from] of inputs) {
  if (!existsSync(from)) {
    console.error(`Eksik build ciktisi: ${from} (once "npm run build")`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
for (const [from, to] of inputs) {
  cpSync(from, to, { recursive: true });
}
console.log(`Release hazir: ${out}/`);
