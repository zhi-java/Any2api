# Admin 管理系统重构 - 实施计划

## Implementation Phases

这是一个分 5 个阶段的渐进式重构计划。每个阶段完成后都要验证功能正常。

---

## Phase 0: 准备工作 ✓

### 任务
- [ ] 备份当前 Admin 系统
- [ ] 创建新的目录结构
- [ ] 准备设计系统基础文件

### 步骤

#### 1. 备份旧系统
```bash
cd src/admin
mv index.html legacy.html
mv chat.html chat-legacy.html
```

#### 2. 创建新目录结构
```bash
cd src/admin
mkdir -p pages styles scripts assets
```

**目标结构**：
```
src/admin/
├── legacy.html         # 旧系统备份
├── chat-legacy.html    # 旧聊天页面
├── index.html          # 新主框架（待创建）
├── pages/              # 各功能页面
├── styles/             # 样式文件
├── scripts/            # JS 模块
└── assets/             # 静态资源
```

#### 3. 创建设计系统基础
- 创建 `styles/design-system.css`（颜色、字体、间距）
- 创建 `styles/layout.css`（布局）
- 创建 `styles/components.css`（组件）

### 验证
- [ ] 目录结构正确
- [ ] 旧系统已备份
- [ ] 可以通过 `/admin/legacy` 访问旧系统

### 时间估计
30 分钟

---

## Phase 1: 基础框架 + Dashboard ✓

### 任务
- [ ] 创建主框架（侧边栏 + 内容区）
- [ ] 实现设计系统
- [ ] 创建 Dashboard 页面
- [ ] 实现轮询更新
- [ ] 集成 Chart.js

### 步骤

#### 1.1 创建设计系统（styles/design-system.css）

**包含内容**：
- CSS 变量（颜色、字体、间距）
- 重置样式
- 基础排版样式

**关键代码**：
```css
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

:root {
  /* 颜色 */
  --bg-primary: #F7F5F1;
  --bg-surface: #FFFFFF;
  --border-default: #E7E3DA;
  --text-primary: #1E2227;
  --text-secondary: #6B7077;
  --accent: #3C5A78;
  --accent-hover: #2E4760;
  
  /* 字体 */
  --font-serif: 'Playfair Display', serif;
  --font-sans: 'Inter', sans-serif;
  
  /* 间距 */
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  
  /* 圆角 */
  --radius-lg: 12px;
  
  /* 阴影 */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-serif);
}
```

#### 1.2 创建布局样式（styles/layout.css）

**包含内容**：
- 主容器布局
- 侧边栏样式
- 内容区样式
- 导航样式

**关键结构**：
```css
.app-container {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 240px;
  background: #EFEDE9; /* 略深于 bg-primary */
  border-right: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  padding: var(--space-8);
  overflow-y: auto;
}
```

#### 1.3 创建组件样式（styles/components.css）

**包含内容**：
- Card 卡片
- Button 按钮
- Table 表格
- Badge 徽章
- Stat Card 统计卡片

**关键组件**：
```css
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  box-shadow: var(--shadow-sm);
}

.stat-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  text-align: center;
}

.stat-value {
  font-size: 2rem;
  font-weight: 600;
  color: var(--text-primary);
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn-primary:hover {
  background: var(--accent-hover);
}
```

#### 1.4 创建主框架（index.html）

**结构**：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - DeepSeek 2API</title>
  <link rel="stylesheet" href="styles/design-system.css">
  <link rel="stylesheet" href="styles/layout.css">
  <link rel="stylesheet" href="styles/components.css">
</head>
<body>
  <div class="app-container">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">DeepSeek 2API</h1>
        <span class="version">v2.0.0</span>
      </div>
      
      <nav class="sidebar-nav">
        <a href="pages/dashboard.html" class="nav-item active" data-page="dashboard">
          <span class="nav-icon">📊</span>
          <span class="nav-label">Dashboard</span>
        </a>
        <a href="pages/deepseek.html" class="nav-item" data-page="deepseek">
          <span class="nav-icon">🤖</span>
          <span class="nav-label">DeepSeek</span>
        </a>
        <a href="pages/glm.html" class="nav-item" data-page="glm">
          <span class="nav-icon">🌐</span>
          <span class="nav-label">GLM</span>
        </a>
        <a href="pages/logs.html" class="nav-item" data-page="logs">
          <span class="nav-icon">📝</span>
          <span class="nav-label">日志</span>
        </a>
        <a href="pages/performance.html" class="nav-item" data-page="performance">
          <span class="nav-icon">⚡</span>
          <span class="nav-label">性能</span>
        </a>
      </nav>
      
      <div class="sidebar-footer">
        <a href="chat-legacy.html" class="btn btn-secondary">聊天测试</a>
        <a href="legacy.html" class="link-secondary">旧版管理</a>
      </div>
    </aside>
    
    <!-- 主内容区 -->
    <main class="content">
      <iframe id="content-frame" src="pages/dashboard.html" frameborder="0"></iframe>
    </main>
  </div>
  
  <script src="scripts/main.js"></script>
</body>
</html>
```

#### 1.5 创建 API 封装（scripts/api.js）

```javascript
const API = {
  base: '/admin/api',
  
  async getStats() {
    const res = await fetch(`${this.base}/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  
  async getLogs(count = 50) {
    const res = await fetch(`${this.base}/logs?count=${count}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  
  async getMetrics(query = {}) {
    const params = new URLSearchParams(query);
    const res = await fetch(`/performance/api/metrics?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};

export default API;
```

#### 1.6 创建轮询管理器（scripts/polling.js）

```javascript
class PollingManager {
  constructor(interval = 5000) {
    this.interval = interval;
    this.timerId = null;
    this.callback = null;
    this.isActive = !document.hidden;
    
    document.addEventListener('visibilitychange', () => {
      this.isActive = !document.hidden;
      if (this.isActive && this.callback) {
        this.callback();
      }
    });
  }
  
  start(callback) {
    this.callback = callback;
    callback();
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

export default PollingManager;
```

#### 1.7 创建 Chart.js 配置（scripts/charts.js）

```javascript
const CHART_THEME = {
  colors: {
    primary: '#3C5A78',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
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
          font: { family: "'Inter', sans-serif", size: 12 },
          padding: 16,
        },
      },
    },
    scales: {
      x: {
        grid: { color: '#E7E3DA' },
        ticks: { color: '#6B7077' },
      },
      y: {
        grid: { color: '#E7E3DA' },
        ticks: { color: '#6B7077' },
      },
    },
  },
};

export { CHART_THEME };
```

#### 1.8 创建 Dashboard 页面（pages/dashboard.html）

**结构**：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard</title>
  <link rel="stylesheet" href="../styles/design-system.css">
  <link rel="stylesheet" href="../styles/components.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    
    .chart-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1rem;
      margin-bottom: 2rem;
    }
    
    .chart-container {
      position: relative;
      height: 300px;
    }
  </style>
</head>
<body>
  <div class="page-header">
    <h1>Dashboard</h1>
    <p class="text-secondary">系统总览</p>
  </div>
  
  <!-- 统计卡片 -->
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">请求总数</div>
      <div class="stat-value" id="stat-requests">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">成功率</div>
      <div class="stat-value" id="stat-success-rate">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">活跃 Token</div>
      <div class="stat-value" id="stat-tokens">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">队列</div>
      <div class="stat-value" id="stat-queue">-</div>
    </div>
  </div>
  
  <!-- 图表 -->
  <div class="chart-grid">
    <div class="card">
      <h3>请求趋势</h3>
      <div class="chart-container">
        <canvas id="requestChart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3>Token 分布</h3>
      <div class="chart-container">
        <canvas id="tokenChart"></canvas>
      </div>
    </div>
  </div>
  
  <script type="module">
    import API from '../scripts/api.js';
    import PollingManager from '../scripts/polling.js';
    import { CHART_THEME } from '../scripts/charts.js';
    
    // 初始化图表
    const requestChart = new Chart(document.getElementById('requestChart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: '请求数',
          data: [],
          borderColor: CHART_THEME.colors.primary,
          backgroundColor: 'rgba(60, 90, 120, 0.1)',
          tension: 0.3,
        }],
      },
      options: CHART_THEME.defaults,
    });
    
    const tokenChart = new Chart(document.getElementById('tokenChart'), {
      type: 'doughnut',
      data: {
        labels: ['活跃', '空闲', '死亡'],
        datasets: [{
          data: [0, 0, 0],
          backgroundColor: [
            CHART_THEME.colors.success,
            CHART_THEME.colors.primary,
            CHART_THEME.colors.error,
          ],
        }],
      },
      options: CHART_THEME.defaults,
    });
    
    // 更新数据
    async function updateDashboard() {
      try {
        const stats = await API.getStats();
        
        // 更新统计卡片
        document.getElementById('stat-requests').textContent = 
          stats.logStats?.totalRequests || '-';
        document.getElementById('stat-success-rate').textContent = 
          ((stats.logStats?.successCount / stats.logStats?.totalRequests * 100) || 0).toFixed(1) + '%';
        document.getElementById('stat-tokens').textContent = 
          stats.pool?.filter(t => !t.dead).length || '-';
        document.getElementById('stat-queue').textContent = 
          stats.queue?.queued || '0';
        
        // 更新 Token 图表
        const alive = stats.pool?.filter(t => !t.dead && t.activeRequests > 0).length || 0;
        const idle = stats.pool?.filter(t => !t.dead && t.activeRequests === 0).length || 0;
        const dead = stats.pool?.filter(t => t.dead).length || 0;
        tokenChart.data.datasets[0].data = [alive, idle, dead];
        tokenChart.update();
        
      } catch (err) {
        console.error('Failed to update dashboard:', err);
      }
    }
    
    // 启动轮询
    const poller = new PollingManager(5000);
    poller.start(updateDashboard);
  </script>
</body>
</html>
```

### 验证
- [ ] 主框架正确显示
- [ ] 侧边栏导航工作正常
- [ ] Dashboard 正确展示统计数据
- [ ] 图表正确渲染
- [ ] 轮询自动更新数据
- [ ] 页面可见性 API 工作正常

### 时间估计
3-4 天

---

## Phase 2: DeepSeek 渠道管理 ✓

### 任务
- [ ] 创建 DeepSeek 管理页面
- [ ] Token 池状态展示
- [ ] 会话池状态展示
- [ ] 账号管理功能
- [ ] 快速操作功能

### 步骤

#### 2.1 创建 pages/deepseek.html

**包含内容**：
- 概览卡片（Token 数、会话数、对话数）
- Token 池表格（状态、并发、错误、操作）
- 会话池状态
- 添加 Token/账号功能

**数据来源**：
- `GET /admin/api/stats`（pool, sessions, conversations 字段）

**关键功能**：
- Token 状态过滤（全部/活跃/死亡）
- 添加 Token：`POST /admin/api/token/add`
- 添加账号：`POST /admin/api/token/login`
- 删除 Token：`POST /admin/api/token/remove`

### 验证
- [ ] Token 池正确展示
- [ ] 会话池正确展示
- [ ] 添加 Token 功能正常
- [ ] 添加账号功能正常
- [ ] 删除 Token 功能正常

### 时间估计
2-3 天

---

## Phase 3: GLM 渠道管理 ✓

### 任务
- [ ] 创建 GLM 管理页面
- [ ] Refresh Token 管理
- [ ] Access Token 缓存状态
- [ ] 模型配置展示
- [ ] 请求统计

### 步骤

#### 3.1 创建 pages/glm.html

**包含内容**：
- 概览卡片（模式、Token 数、请求数）
- Refresh Token 列表
- 模型配置列表
- 添加 Token 功能

**数据来源**：
- 需要新增 `/admin/api/glm/status` API
  - 返回：refresh tokens, access token 缓存, 模型列表

**关键功能**：
- 显示当前模式（访客 or 用户）
- Refresh Token 管理
- 切换访客模式

### 验证
- [ ] GLM 状态正确展示
- [ ] Token 管理功能正常
- [ ] 模型配置正确显示

### 时间估计
2-3 天

---

## Phase 4: 日志 + 性能监控 ✓

### 任务
- [ ] 创建日志查询页面
- [ ] 创建性能监控页面
- [ ] 实现日志筛选
- [ ] 实现性能图表

### 步骤

#### 4.1 创建 pages/logs.html

**包含内容**：
- 筛选工具栏（日期、类型、搜索）
- 日志列表（表格或列表）
- 分页或虚拟滚动

**数据来源**：
- `GET /admin/api/logs`
- `GET /admin/api/logs/history`

#### 4.2 创建 pages/performance.html

**包含内容**：
- 指标概览（p50, p95, p99, RPS）
- 请求延迟趋势图
- 错误率监控图

**数据来源**：
- `GET /performance/api/metrics`

### 验证
- [ ] 日志查询正常
- [ ] 日志筛选正常
- [ ] 性能图表正确显示
- [ ] 指标数据准确

### 时间估计
2-3 天

---

## Phase 5: 完善和替换 ✓

### 任务
- [ ] 完善细节和样式
- [ ] 添加加载状态
- [ ] 添加错误处理
- [ ] 优化性能
- [ ] 删除旧系统
- [ ] 更新路由

### 步骤

#### 5.1 完善细节
- 添加骨架屏（loading skeleton）
- 添加空状态（empty state）
- 添加错误提示（toast/alert）
- 优化动画和过渡

#### 5.2 性能优化
- 图表懒加载
- 虚拟滚动（长列表）
- 防抖和节流

#### 5.3 删除旧系统
```bash
cd src/admin
rm legacy.html chat-legacy.html
```

#### 5.4 更新路由
- `/admin` → 新页面（已经是）
- `/admin/legacy` → 删除
- `/admin/chat` → 保留或重构

### 验证
- [ ] 所有功能完整可用
- [ ] 性能达标（首屏 < 2s）
- [ ] 无内存泄漏
- [ ] 浏览器兼容性良好

### 时间估计
1 天

---

## 验证清单

### 功能验证
- [ ] Dashboard 正确展示所有统计数据
- [ ] DeepSeek 渠道管理完整可用
- [ ] GLM 渠道管理完整可用
- [ ] 日志查询支持筛选
- [ ] 性能监控图表准确
- [ ] 轮询自动更新数据
- [ ] 页面切换流畅

### 设计验证
- [ ] 符合 design_sense 规范
- [ ] 颜色方案正确应用
- [ ] 排版清晰易读
- [ ] 响应式布局适配
- [ ] 所有交互有视觉反馈

### 性能验证
- [ ] 首屏加载 < 2 秒
- [ ] 页面切换 < 100ms
- [ ] 轮询无内存泄漏
- [ ] 图表渲染流畅

### 兼容性验证
- [ ] Chrome/Edge 正常
- [ ] Firefox 正常
- [ ] Safari 正常

---

## 总工作量估计

| Phase | 时间 |
|-------|------|
| Phase 0: 准备工作 | 0.5 天 |
| Phase 1: 基础 + Dashboard | 3-4 天 |
| Phase 2: DeepSeek 管理 | 2-3 天 |
| Phase 3: GLM 管理 | 2-3 天 |
| Phase 4: 日志 + 性能 | 2-3 天 |
| Phase 5: 完善和替换 | 1 天 |
| **总计** | **12-15 天** |

---

## 风险和缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Chart.js 性能问题 | 低 | 中 | 使用数据抽样，限制数据点数量 |
| 轮询导致内存泄漏 | 中 | 中 | 使用 Page Visibility API，正确清理定时器 |
| 浏览器兼容性 | 低 | 低 | 使用现代浏览器特性，避免过旧 API |
| 设计不符合规范 | 低 | 中 | 严格遵循 design_sense，定期 review |

---

**实施计划完成，准备进入审查和启动阶段。**
