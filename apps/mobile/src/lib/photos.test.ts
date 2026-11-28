import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator } from 'expo-image-manipulator';
import { PhotoError, pickFromLibrary, preparePhoto, putToSignedUrl, uploadPhotos } from './photos';

const mockSave = jest.fn(async (_opts: unknown) => ({ uri: 'file:///out.jpg', width: 800, height: 600 }));
const mockCtx: { resize: jest.Mock; renderAsync: jest.Mock } = { resize: jest.fn(() => mockCtx), renderAsync: jest.fn(async () => ({ saveAsync: mockSave })) };
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn(() => mockCtx) }, SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///a.heic', width: 400, height: 300 }] })),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

const blobOf = (size: number) => jest.fn(async () => ({ blob: async () => ({ size }) })) as unknown as typeof fetch;

beforeEach(() => jest.clearAllMocks());

describe('fotograf hazirlama', () => {
  it('kucuk gorsel de her zaman yeniden JPEG olarak kodlanir (EXIF / konum bilgisi tasinmaz); boyut degismez', async () => {
    const p = await preparePhoto({ uri: 'file:///small.heic', width: 800, height: 600 }, blobOf(1234));
    expect(ImageManipulator.manipulate).toHaveBeenCalledWith('file:///small.heic');
    expect(mockCtx.resize).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith({ compress: 0.7, format: 'jpeg' });
    expect(p).toMatchObject({ uri: 'file:///out.jpg', type: 'image/jpeg', size: 1234 });
  });

  it('buyuk gorselin uzun kenari 1920 px\'e indirilir (dikeyde yukseklik)', async () => {
    await preparePhoto({ uri: 'file:///wide.jpg', width: 4032, height: 3024 }, blobOf(1));
    expect(mockCtx.resize).toHaveBeenLastCalledWith({ width: 1920 });
    await preparePhoto({ uri: 'file:///tall.jpg', width: 3024, height: 4032 }, blobOf(1));
    expect(mockCtx.resize).toHaveBeenLastCalledWith({ height: 1920 });
  });

  it('10 MB ustu reddedilir; galeri EXIF istemez ve her secimi hazirlar', async () => {
    await expect(preparePhoto({ uri: 'file:///x.jpg', width: 10, height: 10 }, blobOf(11 * 1024 * 1024))).rejects.toEqual(new PhotoError('Fotoğraf en fazla 10 MB olabilir.'));
    const picked = await pickFromLibrary(3, blobOf(10));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ exif: false, mediaTypes: ['images'], selectionLimit: 3 }));
    expect(picked).toHaveLength(1);
    expect(ImageManipulator.manipulate).toHaveBeenCalledWith('file:///a.heic');
  });

  it('imzali linke PUT: hata Turkce; yuklenen fotograf tekrar yuklenmez', async () => {
    const fail = jest.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(putToSignedUrl({ uploadId: 'u', uploadUrl: 'https://s3.test/u', headers: {} }, {} as Blob, fail)).rejects.toThrow('Fotoğraf yüklenemedi (403).');
    const photo = { uri: 'file:///p.jpg', width: 1, height: 1, type: 'image/jpeg', size: 1, blob: {} as Blob };
    const upload = jest.fn(async () => 'id-1');
    expect(await uploadPhotos([photo], upload)).toEqual(['id-1']);
    expect(await uploadPhotos([photo], upload)).toEqual(['id-1']);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
