/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AUTH_MODE?: 'cognito' | 'mock';
  readonly VITE_COGNITO_REGION?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_USER_POOL_CLIENT?: string;
  readonly VITE_COGNITO_TOKEN_USE?: 'id' | 'access';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
