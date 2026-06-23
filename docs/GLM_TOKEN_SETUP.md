# GLM Token 池管理方案

## 背景

GLM API 需要 refresh token 才能正常工作。参考项目使用 Cloudflare KV 存储 token 池，但我们的项目是 Node.js/Express，需要不同的实现。

## 方案选择

### 方案 1：环境变量（单 Token）- **推荐用于开发/小规模部署**

```bash
# .env
GLM_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

**优点**：
- 实现简单
- 无需额外存储
- 适合个人使用

**缺点**：
- 单点故障
- 无法负载均衡

### 方案 2：配置文件（Token 池）- **推荐用于生产环境**

```json
// config/glm-tokens.json
{
  "tokens": [
    {
      "id": "token1",
      "refresh_token": "eyJhbG...",
      "weight": 1,
      "enabled": true
    },
    {
      "id": "token2",
      "refresh_token": "eyJhbG...",
      "weight": 1,
      "enabled": true
    }
  ]
}
```

**优点**：
- 支持多 token 轮询
- 支持禁用单个 token
- 支持权重分配

**缺点**：
- 需要文件管理
- Token 更新需要重启服务

### 方案 3：数据库存储 - **推荐用于大规模部署**

类似 Cloudflare KV，使用 Redis/MongoDB 等。

## 当前实现（方案 1）

我们已经在 `src/glm.js` 中实现了方案 1：

```javascript
class GlmTokenManager {
  constructor() {
    // 从环境变量读取单个 refresh token
    this.refreshToken = process.env.GLM_REFRESH_TOKEN || null;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getAccessToken() {
    // 如果有 refresh token，尝试刷新
    if (this.refreshToken) {
      try {
        return await this._refresh(this.refreshToken);
      } catch (err) {
        console.warn('Refresh failed, falling back to guest:', err.message);
      }
    }

    // 没有 refresh token 或刷新失败 → 访客模式
    return await this._guestAccess();
  }
}
```

## 如何获取 GLM Refresh Token

### 方法 1：浏览器开发者工具

1. 访问 https://chatglm.cn/
2. 登录你的账号
3. 打开浏览器开发者工具（F12）
4. 切换到 Network 标签页
5. 刷新页面
6. 在请求列表中找到任意 API 请求
7. 查看请求头中的 `Authorization: Bearer eyJ...`
8. 复制 `Bearer` 后面的内容，这就是 refresh token

### 方法 2：使用参考项目的管理面板

参考项目提供了 `/admin` 管理面板，可以：
- 添加/删除 API Keys
- 添加/删除 Refresh Tokens
- 检查 Token 状态

### 方法 3：使用 curl 获取（访客模式）

```bash
curl -X POST https://chatglm.cn/chatglm/user-api/guest/access \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: $(uuidgen | tr -d '-')" \
  -H "X-Request-Id: $(uuidgen | tr -d '-')" \
  -d '{}'
```

## 配置步骤

### 1. 创建 .env 文件

```bash
cd C:/Projects/AI/deepseek-2api-4242-master/deepseek-2api-4242
cp .env.example .env
```

### 2. 添加 GLM Token

编辑 `.env` 文件：

```bash
# GLM Refresh Token（可选，不设置则使用访客模式）
GLM_REFRESH_TOKEN=你的refresh_token
```

### 3. 重启服务

```bash
npm start
```

## 验证配置

```bash
# 测试 GLM API
curl -X POST http://localhost:3000/glm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "glm-4",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

## 访客模式说明

如果不配置 `GLM_REFRESH_TOKEN`，系统会自动使用访客模式（guest access）：

**优点**：
- 无需登录
- 自动获取临时 token

**缺点**：
- 可能有速率限制
- 可能有功能限制
- Token 定期过期需要重新获取

## 未来改进

如果需要支持多 token 池（方案 2），可以：

1. 创建 `src/glm-token-pool.js`
2. 实现轮询选择算法
3. 支持热加载配置文件
4. 添加管理 API 端点

参考实现：
```javascript
class GlmTokenPool {
  constructor(configPath) {
    this.tokens = [];
    this.currentIndex = 0;
    this.loadConfig(configPath);
  }

  loadConfig(path) {
    const config = JSON.parse(fs.readFileSync(path, 'utf-8'));
    this.tokens = config.tokens.filter(t => t.enabled);
  }

  getNextToken() {
    if (this.tokens.length === 0) return null;
    const token = this.tokens[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    return token.refresh_token;
  }
}
```

## 相关链接

- [GLM 官网](https://chatglm.cn/)
- [参考项目](docs/GLM理论参考/)
- [GLM API 文档](docs/GLM模型调用接入指南.md)
