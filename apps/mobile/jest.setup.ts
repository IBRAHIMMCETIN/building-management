// Testler her ortamda (CI dahil, .env olmadan) ayni yapilandirmayla kosar: mock kimlik, demo veri.
process.env.EXPO_PUBLIC_AUTH_MODE = 'mock';
process.env.EXPO_PUBLIC_API_MODE = 'demo';
process.env.EXPO_PUBLIC_WEB_URL = 'https://web.test';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'));

// Bildirim katmani testte etkisiz (expo-notifications'a gidilmez); push testleri kendi sahtesini verir.
jest.mock('@/lib/push/notificationsAdapter', () => ({ notificationsAdapter: require('@/test/notifications').inertNotifications }));

// Biyometri testte yok (expo-local-authentication'a gidilmez); kilit testleri `fakeBiometrics()` verir.
jest.mock('@/lib/lock/biometrics', () => ({ biometrics: require('@/test/biometrics').noBiometrics }));
