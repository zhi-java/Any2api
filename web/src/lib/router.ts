import { useEffect, useState } from 'react';
import {
  Activity,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export type RouteId =
  | 'dashboard'
  | 'channels'
  | 'credentials'
  | 'apiKeys'
  | 'settings'
  | 'logs'
  | 'performance';

export interface RouteMeta {
  id: RouteId;
  label: string;
  eyebrow: string;
  icon: LucideIcon;
  /** 该路由已合并/下线，仅作兼容保留（不在导航中展示）。 */
  hidden?: boolean;
}

/**
 * 导航按语义分组。
 *
 * 为什么分组：原先 7 项平铺，用户需要逐个辨认；分组后按"看什么/管什么/调什么"
 * 一眼定位。分组也顺带解决了"渠道与凭据看起来像同一件事"的困惑——它们现在
 * 明确同属"资源"。
 */
export interface NavGroup {
  title: string;
  items: RouteMeta[];
}

export const ROUTES: RouteMeta[] = [
  { id: 'dashboard', label: '首页', eyebrow: 'Home', icon: LayoutDashboard },
  { id: 'channels', label: '渠道与凭据', eyebrow: 'Channels', icon: Server },
  { id: 'apiKeys', label: 'API Keys', eyebrow: 'Access', icon: KeyRound },
  { id: 'performance', label: '监控', eyebrow: 'Monitor', icon: Activity },
  { id: 'logs', label: '日志', eyebrow: 'Logs', icon: ScrollText },
  { id: 'settings', label: '设置', eyebrow: 'Settings', icon: Settings },
  // 凭据页已并入「渠道与凭据」，保留路由以便旧链接（#credentials）仍可命中。
  { id: 'credentials', label: '凭据', eyebrow: 'Credentials', icon: ShieldCheck, hidden: true },
];

export const NAV_GROUPS: NavGroup[] = [
  { title: '概览', items: ROUTES.filter(r => r.id === 'dashboard') },
  { title: '资源', items: ROUTES.filter(r => r.id === 'channels' || r.id === 'apiKeys') },
  { title: '运维', items: ROUTES.filter(r => r.id === 'performance' || r.id === 'logs') },
  { title: '配置', items: ROUTES.filter(r => r.id === 'settings') },
];

/** 导航中实际可见的项（排除隐藏路由）。 */
export const NAV_ITEMS = ROUTES.filter(r => !r.hidden);

export function routeFromHash(): RouteId {
  const name = window.location.hash.replace(/^#/, '') as RouteId;
  const match = ROUTES.find(route => route.id === name);
  if (!match) return 'dashboard';
  // 隐藏路由（如已合并的 #credentials）重定向到其宿主页面，避免旧书签 404。
  return match.hidden ? 'channels' : match.id;
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
