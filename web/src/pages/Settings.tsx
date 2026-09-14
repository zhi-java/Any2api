import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, Input, PanelHeader, Switch, useToast } from '../components/ui';
import { MetricCard, MetricGrid } from '../components/Metric';
import type { PublicConfig } from '../types';

const TABS = [
  { id: 'service', label: '服务' },
  { id: 'logs', label: '日志' },
  { id: 'session', label: '会话' },
  { id: 'generation', label: '生成' },
  { id: 'startup', label: '启动变量' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** 设置页：按语义分组，改动 PATCH 后回读服务端归一化结果。 */
export function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('service');
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.getConfig();
    setConfig(result.config);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!config) return <EmptyState title="加载运行配置…" />;

  const { server, runtime, deepseek } = config;

  function patch(next: Record<string, unknown>) {
    setConfig(prev => (prev ? { ...prev, ...next } : prev));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.updateConfig({
        server: {
          mergeThinking: server.mergeThinking,
          enablePromptInjection: server.enablePromptInjection,
          systemFingerprint: server.systemFingerprint,
          clientDebugLog: server.clientDebugLog,
          clientDebugLogDir: server.clientDebugLogDir,
          clientDebugLogMaxChars: server.clientDebugLogMaxChars,
        },
        runtime: {
          logDir: runtime.logDir,
          sessionTtlSeconds: runtime.sessionTtlSeconds,
          enableConversationAffinity: runtime.enableConversationAffinity,
          conversationTtlMs: runtime.conversationTtlMs,
          maxConversations: runtime.maxConversations,
          enableFcErrorRetry: runtime.enableFcErrorRetry,
        },
      });
      setConfig(result.config);
      toast('运行配置已保存', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-xl border px-4 py-2 text-sm font-bold transition ${
              item.id === tab
                ? 'border-line-accent bg-accent-soft text-accent'
                : 'border-line bg-surface text-ink-2 hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'service' ? (
        <Card>
          <PanelHeader title="服务行为" hint={<Badge tone="accent">server</Badge>} />
          <div className="grid gap-3">
            <Switch
              checked={server.mergeThinking}
              onChange={next => patch({ server: { ...server, mergeThinking: next } })}
              label="合并 thinking 到 content"
            />
            <Switch
              checked={server.enablePromptInjection}
              onChange={next => patch({ server: { ...server, enablePromptInjection: next } })}
              label="启用工具提示词注入"
            />
            <Field label="OpenAI system_fingerprint">
              <Input
                value={server.systemFingerprint}
                onChange={e => patch({ server: { ...server, systemFingerprint: e.target.value } })}
                placeholder="fp_omni_v1"
              />
            </Field>
          </div>
        </Card>
      ) : null}

      {tab === 'logs' ? (
        <Card>
          <PanelHeader title="日志" hint={<Badge tone="accent">logs</Badge>} />
          <div className="grid gap-3">
            <Field label="日志目录" hint="留空使用数据目录 /logs">
              <Input value={runtime.logDir} onChange={e => patch({ runtime: { ...runtime, logDir: e.target.value } })} />
            </Field>
            <Switch
              checked={server.clientDebugLog}
              onChange={next => patch({ server: { ...server, clientDebugLog: next } })}
              label="启用客户端调试日志"
            />
            <Field label="客户端调试日志目录" hint="留空跟随日志目录">
              <Input
                value={server.clientDebugLogDir}
                onChange={e => patch({ server: { ...server, clientDebugLogDir: e.target.value } })}
              />
            </Field>
            <Field label="单字段最大记录字符数">
              <Input
                type="number"
                min={1000}
                value={server.clientDebugLogMaxChars}
                onChange={e => patch({ server: { ...server, clientDebugLogMaxChars: Number(e.target.value) } })}
              />
            </Field>
          </div>
        </Card>
      ) : null}

      {tab === 'session' ? (
        <Card>
          <PanelHeader title="会话与多轮" hint={<Badge tone="accent">runtime</Badge>} />
          <div className="grid gap-3">
            <Field label="DeepSeek 会话 TTL（秒）" hint="会话缓存复用时长，非能力限制">
              <Input
                type="number"
                min={1}
                value={runtime.sessionTtlSeconds}
                onChange={e => patch({ runtime: { ...runtime, sessionTtlSeconds: Number(e.target.value) } })}
              />
            </Field>
            <Switch
              checked={runtime.enableConversationAffinity}
              onChange={next => patch({ runtime: { ...runtime, enableConversationAffinity: next } })}
              label="启用对话亲和"
            />
            <Field label="对话空闲回收时间（毫秒）">
              <Input
                type="number"
                min={1000}
                value={runtime.conversationTtlMs}
                onChange={e => patch({ runtime: { ...runtime, conversationTtlMs: Number(e.target.value) } })}
              />
            </Field>
            <Field label="最大对话数">
              <Input
                type="number"
                min={1}
                value={runtime.maxConversations}
                onChange={e => patch({ runtime: { ...runtime, maxConversations: Number(e.target.value) } })}
              />
            </Field>
          </div>
        </Card>
      ) : null}

      {tab === 'generation' ? (
        <div className="grid gap-4">
          <Card>
            <PanelHeader title="工具调用容错" hint={<Badge tone="accent">generation</Badge>} />
            <Switch
              checked={runtime.enableFcErrorRetry}
              onChange={next => patch({ runtime: { ...runtime, enableFcErrorRetry: next } })}
              label="工具调用格式错误自动重试"
            />
          </Card>
          <Card>
            <PanelHeader title="当前 DeepSeek 运行参数" hint="上游凭据页维护" />
            <MetricGrid>
              <MetricCard label="认证模式" value={deepseek.authMode} />
              <MetricCard label="每 Token 并发" value={deepseek.maxConcurrentPerToken} />
              <MetricCard label="死亡阈值" value={deepseek.tokenDeadThreshold} />
              <MetricCard label="健康检查（秒）" value={deepseek.healthCheckIntervalSeconds} />
              <MetricCard
                label="上报上下文长度"
                value={`${(deepseek.contextLength / 1024).toFixed(0)}K`}
                hint={`${deepseek.contextLength} tokens`}
              />
              <MetricCard
                label="上报最大输出"
                value={deepseek.maxOutputTokens}
                hint="tokens"
              />
              <MetricCard
                label="上报缓存命中率"
                value={`${deepseek.reportedCacheHitRate}%`}
                hint="展示用，非上游真实值"
              />
            </MetricGrid>
          </Card>
        </div>
      ) : null}

      {tab === 'startup' ? (
        <Card>
          <PanelHeader title="启动层变量" hint={<Badge tone="muted">只读</Badge>} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[12px] font-semibold text-ink-3">
                  <th className="border-b border-line py-2 pr-3">变量</th>
                  <th className="border-b border-line py-2">说明</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['PORT', '监听端口，启动后无法由页面热切换'],
                  ['ZHI2API_ENV_PATH', '环境文件路径，必须在读取环境前决定'],
                  ['ZHI2API_CONFIG_PATH', '配置文件路径，必须在配置加载前决定'],
                  ['ZHI2API_DATA_DIR', '数据目录，影响配置与日志默认路径'],
                  ['HTTP_PROXY / HTTPS_PROXY', '出站代理，涉及底层 dispatcher 初始化，建议部署层配置后重启'],
                ].map(([name, desc]) => (
                  <tr key={name}>
                    <td className="border-b border-line py-3 pr-3">
                      <code className="font-mono text-[13px]">{name}</code>
                    </td>
                    <td className="border-b border-line py-3 text-ink-2">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab !== 'startup' ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存运行配置'}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
