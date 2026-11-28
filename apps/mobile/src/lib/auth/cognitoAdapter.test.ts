import { AuthRequiredError, NetworkError, errorMessage } from '@bm/shared/api/errors';
import { AuthFlowError } from '@bm/shared/auth/errors';
import { encodeMockToken } from '@bm/shared/auth/mockScenarios';
import { fetchAuthSession, signIn } from 'aws-amplify/auth';
import { memoryStorage } from '@/test/renderApp';
import { createCognitoAuthAdapter, readStoredSession } from './cognitoAdapter';

jest.mock('aws-amplify', () => ({ Amplify: { configure: jest.fn() } }));
jest.mock('aws-amplify/auth/cognito', () => ({ cognitoUserPoolsTokenProvider: { setKeyValueStorage: jest.fn() } }));
jest.mock('aws-amplify/auth', () => ({
  fetchAuthSession: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(async () => undefined),
  confirmSignIn: jest.fn(),
  resetPassword: jest.fn(),
  confirmResetPassword: jest.fn(),
  updateUserAttributes: jest.fn(),
}));

/** Imzasiz test token'i (decodeClaims JWT govdesini okur; imza dogrulanmaz). */
const jwt = (claims: Record<string, unknown>) => `h.${encodeMockToken(claims).slice(5)}.s`;
const ID = jwt({ sub: 'u-1', email: 'a@b.c', role: 'resident', apartmentId: 'apt-1', exp: Math.floor(Date.now() / 1000) + 3600 });
const tokens = { idToken: { toString: () => ID }, accessToken: { toString: () => 'access-1' } };
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

const fetchMock = jest.mocked(fetchAuthSession);
const config = { userPoolId: 'eu-north-1_x', clientId: 'client-1' };

beforeEach(() => jest.clearAllMocks());

describe('Cognito adapter hata eslemesi', () => {
  it('yenileme: ag kesintisi NetworkError (oturum korunur), kesin red AuthRequiredError', async () => {
    const adapter = createCognitoAuthAdapter(config, memoryStorage());
    const current = { idToken: ID, accessToken: 'a', claims: { sub: 'u-1', exp: 0 } };

    fetchMock.mockRejectedValueOnce(named('NetworkError', 'A network error has occurred.'));
    await expect(adapter.refresh(current)).rejects.toBeInstanceOf(NetworkError);

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(adapter.refresh(current)).rejects.toBeInstanceOf(NetworkError);

    // Amplify NotAuthorized'da token'lari silip bos doner.
    fetchMock.mockResolvedValueOnce({ tokens: undefined } as never);
    await expect(adapter.refresh(current)).rejects.toBeInstanceOf(AuthRequiredError);

    fetchMock.mockRejectedValueOnce(named('TokenRevokedException'));
    await expect(adapter.refresh(current)).rejects.toBeInstanceOf(AuthRequiredError);

    // Bilinmeyen gecici hata oldugu gibi doner (oturumu dusurme karari SessionManager'da: dusurmez).
    fetchMock.mockRejectedValueOnce(named('InternalErrorException', 'boom'));
    await expect(adapter.refresh(current)).rejects.toThrow('boom');

    fetchMock.mockResolvedValueOnce({ tokens } as never);
    expect((await adapter.refresh(current)).claims).toMatchObject({ sub: 'u-1', role: 'resident', apartmentId: 'apt-1' });
  });

  it('cevrimdisi soguk acilis: saklanan token ile oturum acilir; diger hatada giris ekrani', async () => {
    const storage = memoryStorage();
    await storage.setItem('CognitoIdentityServiceProvider.client-1.LastAuthUser', 'u-1');
    await storage.setItem('CognitoIdentityServiceProvider.client-1.u-1.idToken', ID);
    await storage.setItem('CognitoIdentityServiceProvider.client-1.u-1.accessToken', 'access-1');
    const adapter = createCognitoAuthAdapter(config, storage);

    fetchMock.mockRejectedValueOnce(named('NetworkError'));
    const restored = await adapter.restore();
    expect(restored).toMatchObject({ idToken: ID, accessToken: 'access-1', claims: { sub: 'u-1', role: 'resident' } });

    fetchMock.mockRejectedValueOnce(named('NotAuthorizedException'));
    expect(await adapter.restore()).toBeNull();
  });

  it('saklanan oturum yoksa / bozuksa null', async () => {
    expect(await readStoredSession('client-1', memoryStorage())).toBeNull();
    const storage = memoryStorage();
    await storage.setItem('CognitoIdentityServiceProvider.client-1.LastAuthUser', 'u-1');
    await storage.setItem('CognitoIdentityServiceProvider.client-1.u-1.idToken', 'bozuk');
    await storage.setItem('CognitoIdentityServiceProvider.client-1.u-1.accessToken', 'a');
    expect(await readStoredSession('client-1', storage)).toBeNull();
  });

  it('giris hatalari Turkce AuthFlowError olur', async () => {
    const adapter = createCognitoAuthAdapter(config, memoryStorage());
    jest.mocked(signIn).mockRejectedValueOnce(named('NotAuthorizedException', 'Incorrect username or password.'));
    const err = await adapter.signIn({ email: 'a@b.c', password: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect(errorMessage(err)).toBe('E-posta veya şifre hatalı.');

    jest.mocked(signIn).mockRejectedValueOnce(named('NetworkError'));
    expect(errorMessage(await adapter.signIn({ email: 'a@b.c', password: 'x' }).catch((e: unknown) => e))).toBe('Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.');
  });

  it('giris adimlari: yeni sifre, TOTP ve tamam', async () => {
    const adapter = createCognitoAuthAdapter(config, memoryStorage());
    jest.mocked(signIn).mockResolvedValueOnce({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' } } as never);
    expect(await adapter.signIn({ email: 'a@b.c', password: 'Gecici12345' })).toEqual({ type: 'newPasswordRequired' });
    jest.mocked(signIn).mockResolvedValueOnce({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } } as never);
    expect(await adapter.signIn({ email: 'a@b.c', password: 'x' })).toEqual({ type: 'totpRequired' });
    jest.mocked(signIn).mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } } as never);
    fetchMock.mockResolvedValueOnce({ tokens } as never);
    const done = await adapter.signIn({ email: 'a@b.c', password: 'x' });
    expect(done.type === 'done' && done.session.claims.apartmentId).toBe('apt-1');
  });
});
