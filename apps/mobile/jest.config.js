// jest-expo (iOS on ayari) + @testing-library/react-native. Testler ag / Cognito'ya gitmez.
const path = require('node:path');

const own = (name) => path.join(__dirname, 'node_modules', name);

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/src/**/*.test.ts?(x)'],
  moduleNameMapper: {
    // React tek kopya (metro.config.js ile ayni sebep): kokteki kutuphaneler de mobilin React'ini kullanir.
    '^react$': own('react'),
    '^react/(.*)$': `${own('react')}/$1`,
    '^react-dom$': own('react-dom'),
    '^react-dom/(.*)$': `${own('react-dom')}/$1`,
    '^@/(.*)$': '<rootDir>/src/$1',
    // Derin ikon importlari (src/components/icons.ts): Jest'te CommonJS surumu.
    '^lucide-react-native/icons/(.*)$': `${path.resolve(path.dirname(require.resolve('lucide-react-native')), 'icons')}/$1.js`,
  },
  // Kok node_modules'taki Expo / RN paketleri ve ortak paket (@bm/shared, TS kaynak) derlenir.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|expo-router|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|lucide-react-native|@bm/.*))',
  ],
};
