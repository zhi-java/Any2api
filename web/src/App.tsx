import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { useHashRoute } from './lib/router';
import { Shell, LoginView } from './components/Shell';
import { ToastProvider, useToast } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { ChannelsPage } from './pages/Channels';
import { CredentialsPage } from './pages/Credentials';
import { ApiKeysPage } from './pages/ApiKeys';
import { SettingsPage } from './pages/Settings';
import { LogsPage } from './pages/Logs';
import { PerformancePage } from './pages/Performance';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

function Console() {
  const route = useHashRoute();
  const toast = useToast();
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then(status => {
        if (cancelled) return;
        setAuth(!status.authRequired || status.authenticated ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        if (!cancelled) setAuth('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => setAuth('anonymous');
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  if (auth === 'checking') {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-ink-3">正在加载控制台…</div>
    );
  }

  if (auth === 'anonymous') {
    return (
      <LoginView
        onSubmit={async apiKey => {
          await api.login(apiKey);
          setAuth('authenticated');
          window.location.hash = window.location.hash || '#dashboard';
        }}
      />
    );
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setAuth('anonymous');
      toast('已退出', 'info');
    }
  }

  return (
    <Shell route={route} onLogout={logout}>
      {route === 'dashboard' && <DashboardPage />}
      {route === 'channels' && <ChannelsPage />}
      {route === 'credentials' && <CredentialsPage />}
      {route === 'apiKeys' && <ApiKeysPage />}
      {route === 'settings' && <SettingsPage />}
      {route === 'logs' && <LogsPage />}
      {route === 'performance' && <PerformancePage />}
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Console />
    </ToastProvider>
  );
}
