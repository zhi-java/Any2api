下面是对 https://www.qianwen.com/ 作为 Any2api 新渠道的评估结论。此次只做研究评估，未改动项目源码；另已按 web-access 规范把已验证站点经验记录到 C:\Users\Administrator\.claude\skills\web-access\references\site-patterns\qianwen.com.md。

结论概览
可以接入，但建议按“网页端逆向渠道”分阶段接入，稳定性风险高于现有 GLM。

与现有 GLM 渠道相比，千问网页端的核心难点不在 SSE 解析，而在认证/签名/风控依赖：

GLM 当前实现可在 Node 侧完整生成签名、获取 guest token、refresh token，并直接请求上游；
千问网页端签名依赖前端 webpack 模块、浏览器环境、UC 参数、Baxia/AWSC 风控信息和 cookie；
短期可借助浏览器/前端模块验证通路，长期要么复刻签名链路，要么使用“浏览器会话代理/worker”方式。
如果目标是快速新增渠道，我建议先做 MVP：仅文本对话 + 游客/已登录 Cookie 模式 + SSE 快照解析，暂不承诺工具调用、多模态、文件、PPT/视频等复杂能力。

一手观察结果
1. 站点与前端
   实测打开：

https://www.qianwen.com/

页面信息：

标题：千问-阿里 AI 助手
前端包：@ali/qianwen-web/2.13.3

页面可见入口包括：

新建对话
我的空间
智能体
API 服务
下载电脑端
登录
任务助理
思考
研究
千问高考
PPT 创作
AI 生视频
AI 生图
代码
翻译
AI 写作
录音纪要
登录入口显示：

用千问APP扫码登录

未登录状态下仍可发起游客对话，但有额度/风控不确定性。

2. 风控与认证特征
   页面加载了多个阿里风控相关脚本：

https://g.alicdn.com/AWSC/fireyejs/...
https://g.alicdn.com/AWSC/et/...
https://g.alicdn.com/sd/baxia/...
https://g.alicdn.com/AWSC/AWSC/awsc.js
https://g.alicdn.com/secdev/sufei_data/...
https://o.alicdn.com/baxia/baxia-entry-gray/...

浏览器内可见 cookie 名称包括：

XSRF-TOKEN
_qk_bx_ck_v1
_qw_bx_timeout_v1
b-user-id
cna
isg
tfstk
theme-mode
xlly_s

本地存储中也有千问/风控相关 key：

qianwen-selectModel
qianwen_guest_chat_limit_v1
_qk_busc_info_v1qwen_web
_um_cn__umdata
ETLCD

重要点：千问不是简单 Bearer token 模式。前端签名逻辑大致包括：

公共参数：biz_id、chat_client、device、fr、pr、ut、la、tz、wv/ve
随机/时间参数：nonce、timestamp
签名参数：sign_type=2、sign
可能附加 UC/Quark 参数：uc_param_str 等
可能附加账号态参数：kps_wg、vcode、sign_wg
请求头：x-platform、x-csrf-token、x-device-id、x-chat-id、x-chat-biz
我在浏览器中通过千问自身 webpack 模块调用 doQwenAuth 成功构造请求并调用聊天接口。这说明接入链路真实存在，但也说明纯服务端复刻签名会比 GLM 麻烦。

3. 聊天接口实测
   主聊天 SSE 接口
   实测成功：

POST https://chat2.qianwen.com/api/v2/chat
Content-Type: application/json
Accept: application/json, text/event-stream, text/plain, */*

返回：

Content-Type: text/event-stream;charset=UTF-8
Status: 200

请求体核心字段：

{
"req_id": "...",
"parent_req_id": "0",
"messages": [
{
"mime_type": "text/plain",
"content": "你好，请用一句话回答。",
"meta_data": {},
"status": "complete"
}
],
"scene": "chat",
"sub_scene": "",
"scene_param": "first_turn",
"session_id": "...",
"biz_id": "",
"topic_id": "...",
"model": "",
"from": "",
"protocol_version": "v2",
"messages_merge": false,
"chat_client": "h5",
"deep_search": "0",
"enable_search": false
}

多轮对话推测字段：

parent_req_id：上一轮请求 ID，首轮为 "0"
session_id：会话 ID
topic_id：话题 ID
scene_param：
首轮：first_turn
后续：continue_chat
model：可填模型代码，如 Qwen3.7-Max、Qwen3-Coder 等
4. SSE 响应格式
   千问的 SSE 帧通常是：

data:{...json...}

data:{...json...}

前端解析逻辑把没有显式 event: 的帧视为 message。

典型响应结构：

{
"error_msg": "",
"data": {
"debug": {},
"extra_info": {
"agent_name": "AgentProxy",
"route_name": "Agent代理",
"scene": "general_qa"
},
"messages": [
{
"mime_type": "multi_load/iframe",
"meta_data": {
"multi_load": [],
"ext_info": {}
},
"action": "",
"content": "你好，很高兴用这一句话来回应你！",
"status": "complete"
}
],
"audit_info": {
"error_code": 0
}
},
"error_code": 0,
"communication": {
"sessionid": "...",
"resid": 5,
"reqid": "..."
}
}

文本内容位于：

data.messages[].content

常见 mime_type：

signal/post
bar/progress
bar/iframe
multi_load/iframe
paa/iframe

文本生成时，multi_load/iframe 的 content 是快照式全量内容，不是 token delta。例如：

你好
你好，很高兴用这一句话来
你好，很高兴用这一句话来回应你！

所以解析器需要像 GLM 一样做“快照去重 → delta 输出”。

最终响应中还可以拿到 usage：

{
"extra_info": {
"chat_odps": {
"model_info": {
"model": "qwenchat-3p7-260602-b300"
},
"total_usage": {
"completion_tokens": 11,
"prompt_tokens": 842,
"total_tokens": 853
}
}
}
}

这对 OpenAI/Claude 兼容响应中的 usage 很有价值。

5. 模型列表接口实测
   模型列表不是走 chat2.qianwen.com，而是：

GET https://chat2-api.qianwen.com/api/v1/model/list

实测 chat2.qianwen.com/api/v1/model/list 会 404。

返回模型包括：

modelCode	displayModelName	说明
Qwen	Qwen3.7-千问	默认模型
Qwen3.7-Max	Qwen3.7-Max	最新旗舰模型，擅长代码与复杂任务
Qwen3.5-Flash	Qwen3.5-Flash	简单任务，响应快
Qwen3-Max	Qwen3-Max	日常通用型任务
Qwen3-Max-Thinking-Preview	Qwen3-Max-Thinking	多步骤推理
Qwen3-Coder	Qwen3-Coder	代码生成与编程任务
Qwen3-VL-Plus	Qwen3-VL-Plus	多模态，默认隐藏
Qwen3-Coder-Flash	Qwen3-Coder-Flash	代码快模型，默认隐藏
Qwen3-Omni-Flash	Qwen3-Omni-Flash	全模态，默认隐藏
建议 Any2api 首批暴露：

'qwen',
'qwen-3.7-max',
'qwen-3.5-flash',
'qwen-3-max',
'qwen-3-max-thinking',
'qwen-3-coder'

内部映射到网页端 modelCode：

{
'qwen': 'Qwen',
'qwen-3.7-max': 'Qwen3.7-Max',
'qwen-3.5-flash': 'Qwen3.5-Flash',
'qwen-3-max': 'Qwen3-Max',
'qwen-3-max-thinking': 'Qwen3-Max-Thinking-Preview',
'qwen-3-coder': 'Qwen3-Coder'
}

与现有 GLM 渠道对比
GLM 当前实现特点
现有 GLM 文件：

src/channels/glm/client.js
src/channels/glm/token-manager.js
src/channels/glm/stream-parser.js
src/channels/glm/handlers.js
src/channels/glm/models.js
GLM 请求链路：

OpenAI/Claude 请求
→ convertMessages()
→ glmChatCompletion()
→ chatglm.cn assistant/stream
→ parseGLMStream()
→ OpenAI/Claude 兼容响应

GLM 认证：

guest/access
→ user/refresh
→ access_token
→ Authorization: Bearer access_token

GLM 签名：

timestamp + nonce + 静态 SIGN_SECRET
→ MD5
→ X-Sign

GLM 流解析：

支持多种格式；
对网页端“完整快照”做 delta；
分离 <think>...</think>；
工具调用通过文本指令解析。
千问渠道拟合度
千问和 GLM 相似点：

维度	GLM	千问
上游类型	网页版后端	网页版后端
响应协议	SSE	SSE
文本输出	快照式内容，需要 delta	快照式内容，需要 delta
OpenAI/Claude 适配	可复用现有 handlers 模式	可复用大部分 handlers 模式
模型映射	models.js	可新增 qianwen/models.js
非流式	聚合 SSE 后输出	同样可行
千问更复杂的地方：

维度	GLM	千问
认证	可纯 Node 实现 guest/refresh	依赖 cookie、XSRF、Baxia/AWSC、UC 参数
签名	静态 MD5 逻辑	前端模块 + 浏览器环境 + 风控参数
请求字段	assistant_id + messages	session/topic/req/parent/model/scene 多字段
响应内容	parts / content	data.messages[] 多 mime 类型
usage	有时需要估算	最终帧可取 total_usage
风控稳定性	中等	较高风险
推荐实现方案
方案 A：纯 Node 复刻签名链路
不建议作为第一阶段。

优点：

部署简单；
与 GLM 模式一致；
不依赖浏览器常驻进程。
缺点：

需要复刻前端签名；
需要处理 AWSC/Baxia/UC 参数；
签名逻辑可能随前端版本频繁变化；
可能更容易触发风控。
适合：后续稳定化阶段。

方案 B：浏览器会话代理 / 前端签名 worker
建议作为 MVP。

思路：

使用用户已登录/游客浏览器环境获取签名；
Node 服务调用本地签名 worker 生成 URL/headers；
Any2api 仍然暴露普通 OpenAI/Claude API；
上游调用走 chat2.qianwen.com/api/v2/chat；
响应由 Node 直接读 SSE 并转发。
优点：

能最大程度复用官方前端签名逻辑；
真实浏览器环境天然有 cookie、XSRF、Baxia、设备指纹；
快速验证可用性。
缺点：

部署复杂；
需要常驻浏览器或签名服务；
服务端环境不够“纯净”；
稳定性受页面版本影响。
适合：快速把 qianwen.com 接进 Any2api。

方案 C：使用官方 Qwen Cloud / DashScope API
作为长期稳定替代，不等价于 qianwen.com 网页渠道。

搜索结果中有 Qwen Cloud Conversations API 文档：

Qwen Cloud Conversations API
但这属于官方云 API/平台 API，不是 www.qianwen.com 网页端接口。优点是稳定合规，缺点是可能需要 API Key/计费，且不一定复现网页版免费额度、模型选择和产品功能。

建议新增文件结构
参考 GLM：

src/channels/qianwen/
index.js
client.js
handlers.js
stream-parser.js
models.js
token-manager.js 或 auth-manager.js
utils.js

models.js
维护 Any2api 模型名到千问 modelCode 的映射：

export const QIANWEN_MODEL_MAP = {
'qwen': {
modelCode: 'Qwen',
description: 'Qwen3.7-千问 默认模型',
},
'qwen-3.7-max': {
modelCode: 'Qwen3.7-Max',
description: 'Qwen3.7-Max 旗舰模型',
},
'qwen-3-coder': {
modelCode: 'Qwen3-Coder',
description: 'Qwen3-Coder 代码模型',
},
};

client.js
职责：

将 OpenAI messages 转为千问 messages；
生成 req_id/session_id/topic_id/parent_req_id；
调用认证/签名模块；
请求 https://chat2.qianwen.com/api/v2/chat；
返回 ReadableStream。
stream-parser.js
解析逻辑：

按 \n\n 分割 SSE；
处理 data:；
JSON parse；
从 data.messages[] 提取：
mime_type === 'multi_load/iframe'
content
status
对快照文本做增量 diff；
从最终帧提取 usage：
extra_info.chat_odps.total_usage
extra_info.chat_odps.model_info.model
complete/最终 status 后发出 done。
统一 yield：

{ type: 'content', content: delta }
{ type: 'usage', usage }
{ type: 'model_info', model }
{ type: 'done' }
{ type: 'error', message }

handlers.js
可以高度复制 GLM handlers：

handleQianwenOpenAI
handleQianwenClaude
handleQianwenStreamingOpenAI
handleQianwenNonStreamingOpenAI
handleQianwenStreamingClaude
handleQianwenNonStreamingClaude
工具调用第一阶段建议暂不做真实 tool call，只沿用当前 GLM 的文本注入和解析策略。

路由接入点
需要改：

src/utils/model-router.js
新增：

if (normalized.startsWith('qwen-') || normalized === 'qwen') {
return { channel: 'qianwen', model: normalized };
}

错误提示增加：

qwen-*

src/routes/api.js
新增 import：

import {
handleQianwenCompletion,
handleQianwenClaudeMessages,
QIANWEN_MODEL_MAP,
} from '../channels/qianwen/index.js';

分发：

} else if (channel === 'qianwen') {
return await handleQianwenCompletion(req, res);
}

模型列表合并：

const qianwenModels = Object.keys(QIANWEN_MODEL_MAP).map(id => ({
id,
object: 'model',
created: 1718000000,
owned_by: 'qianwen',
}));

风险评估
高风险
签名链路稳定性

当前可通过前端模块成功签名，但纯 Node 复刻不确定。
前端版本升级可能改签名逻辑。
风控

页面明确加载 AWSC/Baxia。
高频调用、无浏览器环境、异常指纹都可能触发限制。
账号/游客额度

游客模式可用，但额度未知。
登录需千问 APP 扫码，不是普通账号密码 token 刷新模式。
中风险
多轮上下文

千问依赖 session_id、topic_id、parent_req_id。
如果 Any2api 每次把完整历史拍平成一条消息，能工作，但不一定最省额度。
后续可做 conversation affinity，类似 DeepSeek 的会话亲和。
响应 mime 类型复杂

不止文本，还包含进度条、PAA、搜索结果、卡片、iframe 等。
MVP 只提取 multi_load/iframe.content 即可。
模型可用性

模型列表中部分 show=false，不一定对当前账号/游客可用。
首批应只暴露 show=true 的模型。
推荐实施顺序
第一阶段：可用性 MVP
目标：OpenAI /v1/chat/completions 文本流式可用。

新增 src/channels/qianwen/
实现模型映射；
实现请求体构造；
先接浏览器签名/签名 worker 或可复用前端签名方案；
实现 SSE 快照解析；
OpenAI streaming/non-streaming；
/v1/models 暴露 Qwen 模型。
第二阶段：Claude 兼容
复用 convertClaudeRequest；
复用 GLM handler 模式；
输出 Claude SSE；
验证 Claude Code 可用。
第三阶段：稳定化
研究纯 Node 签名可行性；
增加 Cookie/账号池；
增加风控失败识别；
增加 session affinity；
增加 usage 精确统计。
第四阶段：能力扩展
搜索/深度研究开关；
Thinking 模型；
Coder 模型路由；
图片输入/文件输入；
工具调用适配。
我的建议
如果你接下来要我实现，我建议采用这个范围：

新增 Qianwen 渠道 MVP：支持 qwen、qwen-3.7-max、qwen-3-coder 三个模型；支持 OpenAI/Claude 文本对话；支持 stream 和 non-stream；先不做多模态/文件/PPT/视频；认证先抽象为 QianwenAuthManager，为浏览器签名或未来纯 Node 签名预留接口。

这样可以最大程度复用 GLM 的结构，同时把风险集中隔离在 auth-manager.js 和 stream-parser.js 两处。

Sources:

千问网页版入口
千问 quarkchat 页面
通义智文页面
千问官方 AI 创作平台
千问官方 AI 创作平台 create.qianwen.com
chat-api-quark.qianwen.com
Qwen Cloud Conversations API