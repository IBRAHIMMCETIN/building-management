// Testler her ortamda (CI dahil, .env olmadan) ayni yapilandirmayla kosar: mock kimlik, demo veri.
process.env.EXPO_PUBLIC_AUTH_MODE = 'mock';
process.env.EXPO_PUBLIC_API_MODE = 'demo';
process.env.EXPO_PUBLIC_WEB_URL = 'https://web.test';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
