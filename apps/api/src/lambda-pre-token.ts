import { createPreTokenHandler } from './auth/preTokenGeneration.js';

/** Cognito Pre Token Generation V2 tetikleyicisi (Terraform: `infra/cognito.tf`). */
export const handler = createPreTokenHandler();
