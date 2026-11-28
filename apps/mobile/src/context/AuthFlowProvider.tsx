import { type Dispatch, type ReactNode, createContext, use, useReducer } from 'react';
import { type AuthFlowAction, type AuthFlowState, authFlowReducer, initialAuthFlow } from '@/lib/auth/flow';

type AuthFlowValue = { state: AuthFlowState; dispatch: Dispatch<AuthFlowAction> };

const AuthFlowContext = createContext<AuthFlowValue | null>(null);

/** Giris adimlari (giris, yeni sifre, MFA, sifre sifirlama) arasinda paylasilan akis durumu. */
export function AuthFlowProvider({ children, initial = initialAuthFlow }: { children: ReactNode; initial?: AuthFlowState }) {
  const [state, dispatch] = useReducer(authFlowReducer, initial);
  return <AuthFlowContext value={{ state, dispatch }}>{children}</AuthFlowContext>;
}

export function useAuthFlow(): AuthFlowValue {
  const ctx = use(AuthFlowContext);
  if (!ctx) throw new Error('useAuthFlow, AuthFlowProvider icinde kullanilmalidir');
  return ctx;
}
