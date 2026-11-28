import { useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Camera, ImagePlus, X } from '@/components/icons';
import { Alert, AppText, Button, Spinner } from '@/components/ui';
import { MAX_PHOTOS, type PreparedPhoto, photoErrorMessage, pickFromLibrary, takePhoto } from '@/lib/photos';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Props = {
  label?: string;
  photos: PreparedPhoto[];
  onChange: (photos: PreparedPhoto[]) => void;
  disabled?: boolean;
};

const THUMB = 64;

/**
 * Coklu fotograf secici (web: components/tickets/PhotoPicker.tsx): kamera veya galeri, onizleme,
 * kaldirma; en fazla 6. Secilen gorsel yuklemeden once kucultulup sikistirilir (lib/photos.ts);
 * yukleme gonderimde yapilir. Web onizlemesinde kamera dugmesi yoktur (dosya secici yeterli).
 */
export function PhotoPicker({ label = 'Fotoğraflar (isteğe bağlı)', photos, onChange, disabled }: Props) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const room = MAX_PHOTOS - photos.length;

  const add = async (source: 'camera' | 'library') => {
    setError(null);
    setBusy(true);
    try {
      const picked = source === 'camera' ? [await takePhoto()].filter((p): p is PreparedPhoto => !!p) : await pickFromLibrary(room);
      if (picked.length) onChange([...photos, ...picked.slice(0, room)]);
    } catch (err) {
      setError(photoErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <AppText variant="small" weight="medium">
        {label}{' '}
        <AppText variant="caption" tone="muted">{`(${photos.length}/${MAX_PHOTOS})`}</AppText>
      </AppText>
      {photos.length > 0 && (
        <View style={styles.thumbs}>
          {photos.map((p, i) => (
            <View key={`${i}-${p.uri}`} style={[styles.thumb, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
              <Image source={{ uri: p.uri }} style={styles.image} accessibilityLabel={`Eklenen fotoğraf ${i + 1}`} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Eklenen fotoğraf ${i + 1}: kaldır`}
                disabled={disabled}
                hitSlop={12}
                onPress={() => {
                  onChange(photos.filter((_, j) => j !== i));
                  setError(null);
                }}
                style={[styles.remove, { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
              >
                <X size={14} color={colors.text} aria-hidden />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {room > 0 && (
        <View style={styles.actions}>
          {Platform.OS !== 'web' && <Button variant="secondary" icon={Camera} label="Fotoğraf çek" disabled={disabled || busy} onPress={() => void add('camera')} />}
          <Button variant="secondary" icon={ImagePlus} label="Galeriden seç" disabled={disabled || busy} onPress={() => void add('library')} />
          {busy && <Spinner label="Fotoğraf hazırlanıyor" />}
        </View>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space(2) },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  thumb: { width: THUMB, height: THUMB, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  remove: { position: 'absolute', top: space(1), right: space(1), width: space(5), height: space(5), borderRadius: radii.full, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
});
