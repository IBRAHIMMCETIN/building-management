import { render, screen } from '@testing-library/react-native';
import * as Device from 'expo-device';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Screen } from '@/components/ui';
import { isWideGate } from '@/screens/guard/GateScreen';
import { CONTENT_MAX_WIDTH, WIDE_CONTENT_MAX_WIDTH } from '@/theme/tokens';
import { applyOrientationPolicy } from './orientation';

jest.mock('expo-device', () => ({ DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2 }, getDeviceTypeAsync: jest.fn() }));
jest.mock('expo-screen-orientation', () => ({ OrientationLock: { PORTRAIT_UP: 3 }, lockAsync: jest.fn(async () => undefined), unlockAsync: jest.fn(async () => undefined) }));

const deviceType = Device.getDeviceTypeAsync as jest.Mock;

describe('ekran yonu ve tablet yerlesimi', () => {
  beforeEach(() => jest.clearAllMocks());

  it('telefon dikeye kilitlenir', async () => {
    deviceType.mockResolvedValue(Device.DeviceType.PHONE);
    await applyOrientationPolicy();
    expect(ScreenOrientation.lockAsync).toHaveBeenCalledWith(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    expect(ScreenOrientation.unlockAsync).not.toHaveBeenCalled();
  });

  it('tablet (iPad / Android) serbest', async () => {
    deviceType.mockResolvedValue(Device.DeviceType.TABLET);
    await applyOrientationPolicy();
    expect(ScreenOrientation.unlockAsync).toHaveBeenCalled();
    expect(ScreenOrientation.lockAsync).not.toHaveBeenCalled();
  });

  it('yon kilidi hatasi uygulamayi durdurmaz', async () => {
    deviceType.mockRejectedValue(new Error('yok'));
    await expect(applyOrientationPolicy()).resolves.toBeUndefined();
  });

  it('Kapı iki sutun: yatay iPad / tablet; dikey tablet, telefon ve bolunmus ekran tek sutun', () => {
    expect(isWideGate(1180, 820)).toBe(true); // iPad Air yatay
    expect(isWideGate(1024, 768)).toBe(true); // iPad mini / Android tablet yatay
    expect(isWideGate(1024, 1366)).toBe(true); // 12,9" iPad dikey (cok genis)
    expect(isWideGate(820, 1180)).toBe(false); // iPad Air dikey
    expect(isWideGate(800, 1280)).toBe(false); // Android tablet dikey
    expect(isWideGate(507, 820)).toBe(false); // iPad bolunmus ekran
    expect(isWideGate(390, 844)).toBe(false); // telefon
  });

  it('Screen icerigi genis ekranda ortali, en fazla 720 pt; saha ekrani daha genis verebilir', async () => {
    const metrics = { frame: { x: 0, y: 0, width: 1180, height: 820 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
    const { rerender } = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <Screen title="Başlık">
          <Text>İçerik</Text>
        </Screen>
      </SafeAreaProvider>,
    );
    // Basligi saran ilk genislik sinirli kap (ScrollView icerik kabi).
    const container = () => {
      type Box = { maxWidth?: number; alignSelf?: string; width?: string };
      let node = screen.getByRole('header', { name: 'Başlık' }).parent;
      while (node) {
        const style = StyleSheet.flatten((node.props.contentContainerStyle ?? node.props.style) as never) as Box | undefined;
        if (style?.maxWidth !== undefined) return style;
        node = node.parent;
      }
      return undefined;
    };
    expect(container()).toMatchObject({ maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', width: '100%' });
    await rerender(
      <SafeAreaProvider initialMetrics={metrics}>
        <Screen title="Başlık" maxContentWidth={WIDE_CONTENT_MAX_WIDTH}>
          <Text>İçerik</Text>
        </Screen>
      </SafeAreaProvider>,
    );
    expect(container()?.maxWidth).toBe(WIDE_CONTENT_MAX_WIDTH);
  });
});
