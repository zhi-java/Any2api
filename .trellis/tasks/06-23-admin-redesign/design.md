# Admin 管理系统重构 - 技术设计

## Architecture Overview

### 目标架构（现代化多页面应用）

```
src/admin/
├── index.html              # 主框架（侧边栏导航 + 内容区）
├── pages/
│   ├── dashboard.html     # 仪表盘
│   ├── deepseek.html      # DeepSeek 渠道管理
│   ├── glm.html           # GLM 渠道管理
│   ├── logs.html          # 日志查询
│   └── performance.html   # 性能监控
├── styles/
│   ├── design-system.css  # 设计系统（颜色、字体、间距）
│   ├── layout.css         # 布局样式（侧边栏、内容区）
│   └── components.css     # 可复用组件（卡片、按钮、表格）
├── scripts/
│   ├── api.js             # API 调用封装
│   ├── charts.js          # Chart.js 封装和配置
│   ├── polling.js         # 轮询管理器
│   └── utils.js           # 工具函数
└── assets/
    └── (如果需要的话，放图标、logo 等)
```

---

## Design System

遵循 design_sense 规范，创建统一的设计语言。

### 颜色方案

```css
:root {
  /* 背景 */
  --bg-primary: #F7F5F1;        /* 柔和 off-white */
  --bg-surface: #FFFFFF;         /* 纯白表面 */
  
  /* 边框 */
  --border-default: #E7E3DA;     /* 柔和边框 */
  --border-subtle: #F0EDE8;      /* 更淡的边框 */
  
  /* 文字 */
  --text-primary: #1E2227;       /* 主要文本 */
  --text-secondary: #6B7077;     /* 次要文本 */
  --text-tertiary: #9CA3AF;      /* 三级文本 */
  
  /* 强调色 */
  --accent: #3C5A78;             /* muted slate-blue */
  --accent-hover: #2E4760;       /* 悬停态 */
  --accent-light: rgba(60, 90, 120, 0.1); /* 淡背景 */
  
  /* 状态色 */
  --success: #10B981;            /* 成功（绿色） */
  --warning: #F59E0B;            /* 警告（橙色） */
  --error: #EF4444;              /* 错误（红色） */
  --info: #3B82F6;               /* 信息（蓝色） */
  
  /* 阴影 */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}
```

### 排版

```css
/* 字体 */
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

:root {
  --font-serif: 'Playfair Display', serif;
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  
  /* 字号 */
  --text-xs: 0.75rem;    /* 12px */
  --text-sm: 0.875rem;   /* 14px */
  --text-base: 1rem;     /* 16px */
  --text-lg: 1.125rem;   /* 18px */
  --text-xl: 1.25rem;    /* 20px */
  --text-2xl: 1.5rem;    /* 24px */
  --text-3xl: 1.875rem;  /* 30px */
  
  /* 行高 */
  --leading-tight: 1.25;
  --leading-normal: 1.5;
  --leading-relaxed: 1.75;
}

/* 标题使用 Playfair Display */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-serif);
  font-weight: 600;
  line-height: var(--leading-tight);
  color: var(--text-primary);
}

/* 正文使用 Inter */
body {
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--text-primary);
}
```

### 间距系统

```css
:root {
  --space-1: 0.25rem;   /* 4px */
  --space-2: 0.5rem;    /* 8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.25rem;   /* 20px */
  --space-6: 1.5rem;    /* 24px */
  --space-8: 2rem;      /* 32px */
  --space-10: 2.5rem;   /* 40px */
  --space-12: 3rem;     /* 48px */
  --space-16: 4rem;     /* 64px */
  
  /* 圆角 */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
}
```

---

## Layout Structure

### 主框架（index.html）

```
┌────────────────────────────────────────────────┐
│  顶部工具栏（可选）                               │
│  - 面包屑导航                                    │
│  - 快捷操作                                      │
├────────┬──────────────────────────────────────┤
│        │                                        │
│ 侧边栏 │         主内容区                       │
│ 240px  │      (iframe 或动态加载)               │
│        │                                        │
│ - Logo │                                        │
│ - 导航 │                                        │
│ - 版本 │                                        │
│        │                                        │
│        │                                        │
└────────┴──────────────────────────────────────┘
```

### 侧边栏导航

**结构**：
```html
<aside class="sidebar">
  <div class="sidebar-header">
    <h1 class="logo">DeepSeek 2API</h1>
    <span class="version">v2.0.0</span>
  </div>
  
  <nav class="sidebar-nav">
    <a href="pages/dashboard.html" class="nav-item active">
      <span class="nav-icon">📊</span>
      <span class="nav-label">Dashboard</span>
    </a>
    <a href="pages/deepseek.html" class="nav-item">
      <span class="nav-icon">🤖</span>
      <span class="nav-label">DeepSeek</span>
    </a>
    <a href="pages/glm.html" class="nav-item">
      <span class="nav-icon">🌐</span>
      <span class="nav-label">GLM</span>
    </a>
    <a href="pages/logs.html" class="nav-item">
      <span class="nav-icon">📝</span>
      <span class="nav-label">日志</span>
    </a>
    <a href="pages/performance.html" class="nav-item">
      <span class="nav-icon">⚡</span>
      <span class="nav-label">性能</span>
    </a>
  </nav>
  
  <div class="sidebar-footer">
    <a href="/admin/chat" class="btn-secondary">聊天测试</a>
  </div>
</aside>
```

**样式要点**：
- 固定宽度 240px
- 柔和的背景色（略深于 primary）
- 导航项悬停和激活态有明显视觉反馈
- 图标使用 emoji 或简单 SVG

---

## Component Library

### 1. Card（卡片）

**用途**：统计卡片、内容容器

```html
<div class="card">
  <div class="card-header">
    <h3 class="card-title">标题</h3>
  </div>
  <div class="card-body">
    内容
  </div>
</div>
```

**样式**：
```css
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  box-shadow: var(--shadow-sm);
}
```

### 2. Stat Card（统计卡片）

```html
<div class="stat-card">
  <div class="stat-label">请求总数</div>
  <div class="stat-value">12,345</div>
  <div class="stat-change positive">↑ 12.5%</div>
</div>
```

### 3. Button（按钮）

```html
<button class="btn btn-primary">主按钮</button>
<button class="btn btn-secondary">次按钮</button>
<button class="btn btn-ghost">幽灵按钮</button>
```

### 4. Table（表格）

```html
<table class="table">
  <thead>
    <tr>
      <th>Token</th>
      <th>状态</th>
      <th>并发数</th>
      <th>操作</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>xxx...xxx</td>
      <td><span class="badge badge-success">活跃</span></td>
      <td>2 / 2</td>
      <td><button class="btn-sm">操作</button></td>
    </tr>
  </tbody>
</table>
```

### 5. Badge（徽章）

```html
<span class="badge badge-success">成功</span>
<span class="badge badge-warning">警告</span>
<span class="badge badge-error">错误</span>
```

---

## Data Flow

### 轮询更新流程

```
页面加载
  ↓
初始化轮询管理器
  ↓
首次加载数据
  ↓
启动定时器（setInterval）
  ↓
┌─────────────────┐
│ 每 N 秒执行：    │
│ 1. fetch API   │
│ 2. 更新 UI      │
│ 3. 更新时间戳   │
└─────────────────┘
  ↓
页面可见性改变
  ↓
暂停/恢复轮询
  ↓
页面卸载
  ↓
清理定时器
```

### API 调用封装（api.js）

```javascript
const API = {
  base: '/admin/api',
  
  // 获取统计信息
  async getStats() {
    const res = await fetch(`${this.base}/stats`);
    return res.json();
  },
  
  // 获取日志
  async getLogs(count = 50) {
    const res = await fetch(`${this.base}/logs?count=${count}`);
    return res.json();
  },
  
  // 获取指标
  async getMetrics(query) {
    const res = await fetch(`${this.base}/metrics?${new URLSearchParams(query)}`);
    return res.json();
  },
  
  // ... 其他 API
};
```

### 轮询管理器（polling.js）

```javascript
class PollingManager {
  constructor(interval = 5000) {
    this.interval = interval;
    this.timerId = null;
    this.callback = null;
    this.isActive = !document.hidden;
    
    // 监听页面可见性
    document.addEventListener('visibilitychange', () => {
      this.isActive = !document.hidden;
      if (this.isActive && this.callback) {
        this.callback(); // 恢复时立即执行一次
      }
    });
  }
  
  start(callback) {
    this.callback = callback;
    callback(); // 立即执行一次
    this.timerId = setInterval(() => {
      if (this.isActive) {
        callback();
      }
    }, this.interval);
  }
  
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}

// 使用
const poller = new PollingManager(5000);
poller.start(async () => {
  const stats = await API.getStats();
  updateUI(stats);
});
```

---

## Chart Configuration

### Chart.js 主题配置

```javascript
// charts.js
const CHART_THEME = {
  colors: {
    primary: '#3C5A78',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
    grid: '#E7E3DA',
    text: '#6B7077',
  },
  
  font: {
    family: "'Inter', sans-serif",
    size: 12,
    weight: 400,
  },
  
  defaults: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: '#6B7077',
          font: {
            family: "'Inter', sans-serif",
            size: 12,
          },
          padding: 16,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: '#1E2227',
        titleColor: '#FFFFFF',
        bodyColor: '#FFFFFF',
        borderColor: '#E7E3DA',
        borderWidth: 1,
        padding: 12,
        boxPadding: 6,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        grid: {
          color: '#E7E3DA',
          drawBorder: false,
        },
        ticks: {
          color: '#6B7077',
        },
      },
      y: {
        grid: {
          color: '#E7E3DA',
          drawBorder: false,
        },
        ticks: {
          color: '#6B7077',
        },
      },
    },
  },
};

// 应用主题
Chart.defaults.font.family = CHART_THEME.font.family;
Chart.defaults.color = CHART_THEME.colors.text;
```

### 图表类型示例

**折线图**（请求趋势）：
```javascript
new Chart(ctx, {
  type: 'line',
  data: {
    labels: ['10:00', '10:05', '10:10', ...],
    datasets: [{
      label: '请求数',
      data: [120, 145, 132, ...],
      borderColor: CHART_THEME.colors.primary,
      backgroundColor: 'rgba(60, 90, 120, 0.1)',
      tension: 0.3,
    }],
  },
  options: CHART_THEME.defaults,
});
```

**环形图**（Token 使用）：
```javascript
new Chart(ctx, {
  type: 'doughnut',
  data: {
    labels: ['活跃', '空闲', '死亡'],
    datasets: [{
      data: [10, 5, 2],
      backgroundColor: [
        CHART_THEME.colors.success,
        CHART_THEME.colors.primary,
        CHART_THEME.colors.error,
      ],
    }],
  },
  options: CHART_THEME.defaults,
});
```

---

## Page-Specific Design

### 1. Dashboard（仪表盘）

**布局**：
```
┌──────────────────────────────────────────────┐
│  统计卡片网格（4 列）                          │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │
│  │请求 │ │成功 │ │Token│ │队列 │             │
│  └─────┘ └─────┘ └─────┘ └─────┘             │
├──────────────────────────────────────────────┤
│  ┌───────────────┐  ┌──────────────┐         │
│  │ 请求趋势图     │  │ Token 分布   │         │
│  │ (折线图)      │  │ (环形图)     │         │
│  └───────────────┘  └──────────────┘         │
├──────────────────────────────────────────────┤
│  渠道状态表格                                  │
│  ┌──────────────────────────────────────┐    │
│  │ DeepSeek | 活跃 | 32 tokens | ...    │    │
│  │ GLM      | 活跃 | 3 tokens  | ...    │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

**数据来源**：`GET /admin/api/stats`

---

### 2. DeepSeek 渠道管理

**布局**：
```
┌──────────────────────────────────────────────┐
│  概览卡片                                      │
│  ┌─────┐ ┌─────┐ ┌─────┐                     │
│  │Token│ │会话 │ │对话 │                     │
│  └─────┘ └─────┘ └─────┘                     │
├──────────────────────────────────────────────┤
│  Token 池管理                                 │
│  ┌────────────────────────────────────────┐  │
│  │ Token      | 状态 | 并发 | 错误 | 操作│  │
│  │ xxx...xxx  | 活跃 | 2/2  | 0    | ... │  │
│  └────────────────────────────────────────┘  │
│  [+ 添加 Token]  [批量操作▼]                 │
├──────────────────────────────────────────────┤
│  会话池状态                                    │
│  ┌────────────────────────────────────────┐  │
│  │ 活跃会话: 15  │  预热会话: 10           │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**数据来源**：`GET /admin/api/stats`（pool, sessions 字段）

---

### 3. GLM 渠道管理

**布局**：
```
┌──────────────────────────────────────────────┐
│  概览卡片                                      │
│  ┌─────┐ ┌─────┐ ┌─────┐                     │
│  │模式 │ │Token│ │请求 │                     │
│  └─────┘ └─────┘ └─────┘                     │
├──────────────────────────────────────────────┤
│  Refresh Token 管理                           │
│  ┌────────────────────────────────────────┐  │
│  │ Token      | 缓存状态 | 过期时间 | 操作│  │
│  │ xxx...xxx  | 已缓存   | 55分钟   | ... │  │
│  └────────────────────────────────────────┘  │
│  [+ 添加 Token]  [切换访客模式]              │
├──────────────────────────────────────────────┤
│  模型配置                                      │
│  ┌────────────────────────────────────────┐  │
│  │ glm-5.2, glm-4-plus, glm-4, ...        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**数据来源**：需要新增 `/admin/api/glm/status` API（返回 GLM 渠道特定信息）

---

### 4. 日志查询

**布局**：
```
┌──────────────────────────────────────────────┐
│  筛选工具栏                                    │
│  [日期选择] [类型▼] [搜索框] [刷新] [导出]   │
├──────────────────────────────────────────────┤
│  日志列表（虚拟滚动或分页）                    │
│  ┌────────────────────────────────────────┐  │
│  │ 10:25:32 | INFO  | Request received   │  │
│  │ 10:25:33 | ERROR | Token expired      │  │
│  │ ...                                    │  │
│  └────────────────────────────────────────┘  │
│  [加载更多]                                   │
└──────────────────────────────────────────────┘
```

**数据来源**：`GET /admin/api/logs`, `GET /admin/api/logs/history`

---

### 5. 性能监控

**布局**：
```
┌──────────────────────────────────────────────┐
│  指标概览                                      │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │
│  │ p50 │ │ p95 │ │ p99 │ │RPS  │             │
│  └─────┘ └─────┘ └─────┘ └─────┘             │
├──────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐    │
│  │ 请求延迟趋势图（折线图）              │    │
│  └──────────────────────────────────────┘    │
├──────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐    │
│  │ 错误率监控（折线图）                  │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

**数据来源**：`GET /performance/api/metrics`

---

## Migration Strategy

### 渐进式迁移计划

**Phase 1：共存阶段**
- 保留旧 Admin（`src/admin/index.html` → `src/admin/legacy.html`）
- 新建 `src/admin/index.html`（新框架）
- 路由：
  - `/admin` → 新页面
  - `/admin/legacy` → 旧页面（保留作为备份）

**Phase 2：逐步迁移**
- 先上线 Dashboard 和一个渠道管理
- 收集用户反馈
- 继续完成其他模块

**Phase 3：完全替换**
- 所有模块完成后
- 删除 `legacy.html`
- 清理旧的 CSS/JS

---

## Compatibility

### 浏览器支持
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

### 技术兼容性
- ES6+ 特性（const/let, arrow function, async/await）
- CSS Grid 和 Flexbox
- Fetch API
- Page Visibility API

---

## Performance Targets

- **首屏加载**: < 2 秒
- **页面切换**: < 100ms
- **轮询开销**: < 5MB/hour（5 秒间隔）
- **图表渲染**: < 200ms

---

## Security Considerations

- 使用现有的 API Key 认证（无需改动）
- 所有 API 调用通过 HTTPS
- 敏感信息（Token）只显示前后缀
- 无客户端存储敏感数据

---

## Success Criteria

- [ ] 所有页面符合 design_sense 设计规范
- [ ] Dashboard 正确展示所有统计数据
- [ ] 渠道管理功能完整可用
- [ ] 图表正确渲染和更新
- [ ] 轮询无内存泄漏
- [ ] 响应式布局适配桌面和平板
- [ ] 首屏加载 < 2 秒

---

**设计完成，准备进入实施计划阶段（implement.md）。**
