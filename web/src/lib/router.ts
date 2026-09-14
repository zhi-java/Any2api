import { useEffect, useState } from 'react';

export type RouteId =
  | 'dashboard'
  | 'channels'
  | 'credentials'
  | 'apiKeys'
  | 'settings'
  | 'logs'
  | 'performance';

export const ROUTES: { id: RouteId; label: string; eyebrow: string }[] = [
  { id: 'dashboard', label: '首页', eyebrow: 'Home' },
  { id: 'channels', label: '渠道', eyebrow: 'Channels' },
  { id: 'credentials', label: '凭据', eyebrow: 'Credentials' },
  { id: 'apiKeys', label: 'API Keys', eyebrow: 'Access' },
  { id: 'settings', label: '设置', eyebrow: 'Settings' },
  { id: 'logs', label: '日志', eyebrow: 'Logs' },
  { id: 'performance', label: '监控', eyebrow: 'Monitor' },
];

export function routeFromHash(): RouteId {
  const name = window.location.hash.replace(/^#/, '') as RouteId;
  return ROUTES.some(route => route.id === name) ? name : 'dashboard';
}

/** hash 路由订阅（零依赖，保持可分享 URL）。 */
export function useHashRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(routeFromHash);

  useEffect(() => {
    const onChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
