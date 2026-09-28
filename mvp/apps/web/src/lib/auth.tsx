import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, get, onSessionLost, refreshSession, setAccessToken } from './api';

export interface Me {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
  permissions: string[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(...perms: string[]): boolean;
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

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ accessToken: string }>('POST', '/auth/login', { email, password });
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

  return <Ctx.Provider value={{ me, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider не подключён');
  return v;
}
