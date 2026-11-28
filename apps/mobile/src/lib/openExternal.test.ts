import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';
import { openDocument } from './openExternal';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

const signed = { url: 'https://s3.test/belge.pdf?sig=1', fileName: 'belge.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' };

describe('openDocument (imzali belge linki)', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('iOS: sistem goruntuleyicisi (Linking)', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await openDocument(async () => signed);
    expect(open).toHaveBeenCalledWith(signed.url);
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('Android: sessiz indirme yerine uygulama ici tarayici (Custom Tabs)', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await openDocument(async () => signed);
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(signed.url, expect.any(Object));
    expect(open).not.toHaveBeenCalled();
    os.restore();
  });
});
