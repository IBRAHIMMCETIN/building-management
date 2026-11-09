import { env } from '@/config/env';
import { cognitoAuthAdapter } from './cognitoAdapter';
import { mockAuthAdapter } from './mockAdapter';
import type { AuthAdapter } from './session';

export const authAdapter: AuthAdapter = env.authMode === 'mock' ? mockAuthAdapter : cognitoAuthAdapter;

export * from './session';
