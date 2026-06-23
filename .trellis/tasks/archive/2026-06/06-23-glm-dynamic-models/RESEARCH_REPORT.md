# GLM API 模型列表探索报告

## 执行时间
2026-06-23

## 研究目标
确定 GLM API 是否提供动态获取模型列表的端点，并找到 GLM 实际支持的最新模型

---

## 研究方法

### Phase 1: 编程测试（API 端点探索）
测试了 8 个可能的端点：
- `/chatglm/backend-api/assistant/list`
- `/chatglm/backend-api/assistants`
- `/chatglm/backend-api/models`
- 其他 5 个端点

**结果**：
- ✓ `/chatglm/backend-api/assistant/list` 返回 405 Method Not Allowed（端点存在）
- POST 测试返回 401 "You need login to access this resource."（需要用户 token）
- ✗ 其他 7 个端点返回 404 Not Found

### Phase 2: 浏览器真实探索
使用 CDP 模式访问 `https://chatglm.cn` 实际网站

**发现**：
- ✅ **GLM-5.2** 是当前主推的旗舰模型
- 页面顶部显示模型选择器，默认显示 "GLM-5.2"
- 页面标注为"最新旗舰模型上线"

---

## 核心发现

### ✅ 确认的最新模型

**GLM-5.2** - 智谱清言最新旗舰模型

**来源**：
- 官方网站 `https://chatglm.cn` 主页展示
- 页面顶部模型选择器默认选项
- 标注为"最新旗舰模型上线"

### 🔍 潜在的 API 端点

**端点**: `POST https://chatglm.cn/chatglm/backend-api/assistant/list`

**状态**: 存在，但需要真实用户 token（非访客 token）

**认证要求**:
- ❌ 访客 token 不可用（返回 401）
- ✅ 需要真实用户 token（通过 `GLM_REFRESH_TOKEN` 获取）

**推测用途**:
- 可能返回所有可用的 assistant（包括模型）
- 可能包含模型信息或 assistant_id 映射

---

## 结论与建议

### ✅ 推荐方案：更新硬编码模型列表

基于真实探索的发现，推荐**直接更新硬编码模型列表**添加 GLM-5.2：

```javascript
const MODEL_MAP = {
  'glm-5.2':       { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'chat' },  // ← 新增
  'glm-4':         { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'glm-4-plus':    { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'chat' },
  'glm-4-search':  { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: true,  type: 'chat' },
  'glm-4v':        { assistantId: DEFAULT_ASSISTANT_ID, plusModel: true,  search: false, type: 'vision' },
  'glm-4-flash':   { assistantId: DEFAULT_ASSISTANT_ID, plusModel: false, search: false, type: 'chat' },
  'cogview-3':     { assistantId: COGVIEW_ASSISTANT_ID, plusModel: false, search: false, type: 'image' },
};
```

**理由**：
1. ✅ GLM-5.2 是官方网站明确展示的最新模型
2. ✅ 简单可靠，无需额外 API 调用
3. ✅ 性能最优（无网络开销）
4. ✅ 符合当前架构（其他模型也是硬编码）

### ⚠️ 动态 API 方案的限制

虽然找到了 `/assistant/list` 端点，但存在以下问题：
1. **认证障碍**：需要真实用户 token，不适合通用部署
2. **用途不明**：不确定返回的数据格式和内容
3. **维护成本高**：需要额外的缓存、错误处理、降级逻辑
4. **收益有限**：GLM 模型更新频率较低

---

## 实施建议

### 短期（立即执行）
1. 添加 `glm-5.2` 到 `MODEL_MAP`
2. 更新模型路由器支持 `glm-5.2` 前缀
3. 更新文档和 CHANGELOG

### 中期（可选）
- 定期检查 GLM 官网，手动更新模型列表
- 考虑添加模型版本检查脚本

### 长期（低优先级）
- 如果未来获得稳定的模型列表 API，可以考虑动态获取
- 但当前不建议投入资源开发

---

## 技术细节

### 已验证的信息

#### GLM 官网
- URL: `https://chatglm.cn`
- 当前主推模型：GLM-5.2
- 标注：最新旗舰模型

#### 已测试的 API 端点
| 端点 | 方法 | 状态 | 说明 |
|------|------|------|------|
| `/chatglm/backend-api/assistant/list` | GET | 405 | Method Not Allowed |
| `/chatglm/backend-api/assistant/list` | POST | 401 | 需要用户 token |
| 其他 7 个端点 | GET | 404 | 不存在 |

#### 模型命名规则
- GLM 模型使用 `glm-x.y` 格式（x 为主版本，y 为次版本）
- 当前已知：`glm-4`, `glm-4-plus`, `glm-4-flash`, `glm-4v`, `glm-5.2`

---

## 结论

✅ **发现最新模型**：GLM-5.2

✅ **推荐方案**：更新硬编码模型列表

❌ **不推荐**：动态 API 获取（成本高、收益低、认证复杂）

---

**研究执行人**: AI Development Team  
**状态**: 已完成，建议更新硬编码模型列表

