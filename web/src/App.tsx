import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { useHashRoute } from './lib/router';
import { Shell, LoginView } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, useToast } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { ChannelsPage } from './pages/Channels';
import { ApiKeysPage } from './pages/ApiKeys';
import { SettingsPage } from './pages/Settings';
import { LogsPage } from './pages/Logs';
import { PerformancePage } from './pages/Performance';

type AuthState = 'checking' | 'authenticated' | 'anonymous' | 'expired';

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

  // 会话过期与"从未登录"必须区别对待。
  //
  // 原先两者都切到 'anonymous'，直接卸载整个控制台 → 用户正在填的表单
  // （新凭据、API Key、设置项）全部丢失，且没有任何提示说明为什么突然
  // 回到了登录页。现在保留当前页面状态、以覆盖层要求重新登录。
  useEffect(() => {
    const onExpired = () => {
      setAuth(prev => (prev === 'authenticated' ? 'expired' : prev));
    };
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
    <>
      <Shell route={route} onLogout={logout}>
        {/* key={route} 让切换页面时重建边界：否则在某页出错后，切到其它页
            仍会停留在错误态（错误状态是持久的，不会因 children 变化自动清除）。 */}
        <ErrorBoundary key={route}>
          {route === 'dashboard' && <DashboardPage />}
          {/* 凭据已并入渠道页；routeFromHash 会把旧的 #credentials 重定向到这里。 */}
          {route === 'channels' && <ChannelsPage />}
          {route === 'apiKeys' && <ApiKeysPage />}
          {route === 'settings' && <SettingsPage />}
          {route === 'logs' && <LogsPage />}
          {route === 'performance' && <PerformancePage />}
        </ErrorBoundary>
      </Shell>

      {/* 会话过期：以覆盖层重新登录，页面组件保持挂载，表单内容不丢。 */}
      {auth === 'expired' ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/40 p-6 backdrop-blur-[2px]">
          <div className="w-full max-w-[420px]">
            <LoginView
              embedded
              title="会话已过期"
              description="登录状态已失效（通常是服务重启或会话超时）。重新登录后你刚才填写的内容会保留。"
              submitLabel="重新登录"
              onSubmit={async apiKey => {
                await api.login(apiKey);
                setAuth('authenticated');
                toast('已重新登录', 'success');
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Console />
    </ToastProvider>
  );
}
