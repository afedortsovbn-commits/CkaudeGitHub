import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, get, onSessionLost, refreshSession, setAccessToken } from './api';
import { t } from './i18n';
import type { RoleUi } from './nav';

export interface Me {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
  permissions: string[];
  /** Названия ролей (в том числе созданных администратором). */
  roleNames?: Record<string, string>;
  /** Интерфейс по умолчанию по ролям (меню, стартовая страница, вкладки); null — стандартный. */
  ui?: RoleUi | null;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  /** Вход по паролю; если нужна вторая ступень — возвращает, что показать (код или настройку 2FA). */
  login(email: string, password: string): Promise<MfaStep | null>;
  loginTotp(mfaToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
  can(...perms: string[]): boolean;
}

export interface MfaStep {
  mfaToken: string;
  /** Настройка 2FA при входе (администратору она обязательна): секрет и ссылка для QR. */
  setup?: { secret: string; otpauthUrl: string };
}

interface LoginResponse {
  accessToken?: string;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  mfaToken?: string;
  secret?: string;
  otpauthUrl?: string;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Восстановление сессии после перезагрузки страницы (refresh-cookie).
    void (async () => {
      if (await refreshSession()) setMe(await get<Me>('/auth/me').catch(() => null));
      setLoading(false);
    })();
    return onSessionLost(() => setMe(null));
  }, []);

  // Права и интерфейс роли могли измениться (администратор правит роль) — перечитываем при возврате на вкладку.
  useEffect(() => {
    if (!me) return;
    const onFocus = () => {
      void get<Me>('/auth/me')
        .then((fresh) => {
          setMe((cur) => (cur && JSON.stringify(cur) === JSON.stringify(fresh) ? cur : fresh));
        })
        .catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [!!me]);

  const login = useCallback(async (email: string, password: string): Promise<MfaStep | null> => {
    const r = await api<LoginResponse>('POST', '/auth/login', { email, password });
    if (r.mfaToken && (r.mfaRequired || r.mfaSetupRequired)) {
      return {
        mfaToken: r.mfaToken,
        setup: r.mfaSetupRequired ? { secret: r.secret!, otpauthUrl: r.otpauthUrl! } : undefined,
      };
    }
    setAccessToken(r.accessToken!);
    setMe(await get<Me>('/auth/me'));
    return null;
  }, []);

  const loginTotp = useCallback(async (mfaToken: string, code: string) => {
    const r = await api<{ accessToken: string }>('POST', '/auth/login/totp', { mfaToken, code });
    setAccessToken(r.accessToken);
    setMe(await get<Me>('/auth/me'));
  }, []);

  const logout = useCallback(async () => {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    setAccessToken(null);
    setMe(null);
  }, []);

  const can = useCallback(
    (...perms: string[]) => !!me && perms.some((p) => me.permissions.includes(p)),
    [me],
  );

  return <Ctx.Provider value={{ me, loading, login, loginTotp, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error(t.authLib.authproviderNePodklyuchen);
  return v;
}
