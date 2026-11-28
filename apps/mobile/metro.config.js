// Expo Metro yapilandirmasi. SDK 52+ monorepo (npm workspaces) ayarlarini kendisi yapar
// (watchFolders, nodeModulesPaths); burada yalnizca React tekillestirmesi eklenir.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/*
 * React tek kopya olmali. Mobil, Expo SDK'nin sabitledigi React surumunu (apps/mobile/node_modules)
 * kullanir; web (apps/web) kok node_modules'taki farkli surumu kullanir. Kokte duran kutuphaneler
 * (react-native-web, @tanstack/react-query, expo-router...) `react` istediginde kok kopyaya
 * gitmesinler diye `react` / `react-dom` her zaman uygulamanin kendi kopyasindan cozulur.
 * (Native platformlarda Expo autolinking ayni seyi yapar; web icin yapmaz.)
 */
const SINGLETONS = /^(react|react-dom)(\/.*)?$/;
const appOrigin = path.join(__dirname, 'index.ts');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (SINGLETONS.test(moduleName)) {
    return context.resolveRequest({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
