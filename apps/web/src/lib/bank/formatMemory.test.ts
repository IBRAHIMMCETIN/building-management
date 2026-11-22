import { describe, expect, it } from 'vitest';
import { FORMAT_SOURCE_LABELS, formatSavedMessage, rememberFormatOption } from './formatMemory';

describe('sutun eslemesini hatirlama', () => {
  it('kayitli esleme kullanildiysa secenek gosterilmez; elle/otomatik eslemede varsayilan acik', () => {
    expect(rememberFormatOption('saved')).toEqual({ visible: false, defaultChecked: false });
    expect(rememberFormatOption('request')).toEqual({ visible: true, defaultChecked: true });
    expect(rememberFormatOption('detected')).toEqual({ visible: true, defaultChecked: true });
    expect(FORMAT_SOURCE_LABELS.saved).toContain('kayıtlı');
  });

  it('aktarim sonucu bildirimi', () => {
    expect(formatSavedMessage(undefined)).toBeNull();
    expect(formatSavedMessage(null)).toContain('zaten kayıtlıydı');
    expect(formatSavedMessage({ version: 1 })).toContain('kaydedildi');
    expect(formatSavedMessage({ version: 3 })).toContain('sürüm 3');
  });
});
