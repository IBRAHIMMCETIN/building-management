// Web onizlemesi, API ve Cognito olmadan: mock kimlik + demo veri (EXPO_PUBLIC_API_MODE=demo).
//   npm run web:demo -w @bm/mobile            (http://localhost:8081)
//   npm run web:demo -w @bm/mobile -- --port 8090
// Ortamda tanimli degerler onceliklidir; Expo CLI .env dosyalarini da okur ama bunlari ezmez.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = require.resolve('expo/bin/cli');
const cwd = dirname(dirname(fileURLToPath(import.meta.url)));

const env = {
  ...process.env,
  EXPO_PUBLIC_AUTH_MODE: process.env.EXPO_PUBLIC_AUTH_MODE ?? 'mock',
  EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE ?? 'demo',
  EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL ?? 'https://building-management-apx.pages.dev',
};

const child = spawn(process.execPath, [cli, 'start', '--web', ...process.argv.slice(2)], { cwd, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
