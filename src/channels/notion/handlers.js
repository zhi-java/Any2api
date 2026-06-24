/**
 * Notion AI 渠道 — 协议处理
 *
 * 将 OpenAI Chat Completions / Anthropic Messages 协议转换为
 * Notion AI 的 runInferenceTranscript 请求。
 *
 * 数据流：
 *   messages → prompt → runInferenceTranscript payload
 *   → NDJSON 流 → 统一事件 → SSE/JSON 响应
 *
 * 请求体格式参考：docs/参考/app/notion_client.go buildInferencePayload()
 */

import crypto from 'crypto';
import { textFromContent, writeSSE, writeClaudeSSE, flushSSE } from '../../utils/response-utils.js';
import { convertClaudeRequest } from '../../adapters/claude.js';
import { NotionClient } from './client.js';
import { parseNotionNDJSON, consumeNotionStream } from './stream-parser.js';
import { getSessionInfo } from './session.js';
import { toNotionModel } from './models.js';
import { browserFallback, isTrustRuleDenied } from './browser-fallback.js';

// ============= 工具函数 =============

function uuid() { return crypto.randomUUID(); }

function isoNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, '+08:00')
    .replace('Z', '+08:00');
}

function nowMs() { return Date.now(); }

// ============= 消息 → 文本转换 =============

function buildPromptText(messages) {
  let prompt = '';
  for (const msg of messages) {
    const role = msg.role;
    if (role === 'system') {
      prompt += `[System]: ${textFromContent(msg.content)}\n\n`;
    } else if (role === 'user') {
      prompt += `[User]: ${textFromContent(msg.content)}\n\n`;
    } else if (role === 'assistant') {
      const content = textFromContent(msg.content);
      if (content) prompt += `[Assistant]: ${content}\n\n`;
    } else if (role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    } else if (role === 'function') {
      prompt += `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}\n\n`;
    }
  }
  return prompt.trim();
}

// ============= 推理执行（含浏览器回退） =============

/**
 * 执行推理，遇到 trust-rule-denied 时自动回退到浏览器
 *
 * @param {NotionClient} client
 * @param {import('./session.js').SessionInfo} session
 * @param {object} payload - runInferenceTranscript 请求体
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{body: ReadableStream, isBrowserFallback: boolean}>}
 */
async function runInferenceWithFallback(client, session, payload, opts = {}) {
  // 第一步：尝试 HTTP API
  const response = await client.runInferenceTranscript(payload);

  // 快速预检：检查 NDJSON 第一行是否为 trust-rule-denied
  const reader = response.body.getReader();
  const first = await reader.read();
  if (!first.done && first.value) {
    const firstChunk = new TextDecoder().decode(first.value, { stream: true });
    if (firstChunk.includes('trust-rule-denied')) {
      // 关闭 HTTP 流，回退到浏览器
      await reader.cancel().catch(() => {});
      console.log('[Notion] trust-rule-denied, falling back to browser...');
      const ndjsonText = await browserFallback(session, payload);
      // 用 ReadableStream 包装 NDJSON 文本，让上层代码一致处理
      return {
        body: ndjsonTextToStream(ndjsonText),
        isBrowserFallback: true,
      };
    }
  }

  // 重新包装流（包含已读取的第一个 chunk）
  const bodyWithFirst = rewrapStream(response.body, first);
  return { body: bodyWithFirst, isBrowserFallback: false };
}

/**
 * 将 NDJSON 文本包装成 ReadableStream
 * @param {string} text
 * @returns {ReadableStream}
 */
function ndjsonTextToStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * 将已读取了第一个 chunk 的流重新包装
 * @param {ReadableStream} originalStream
 * @param {ReadableStreamReadResult} firstRead
 * @returns {ReadableStream}
 */
function rewrapStream(originalStream, firstRead) {
  const reader = originalStream.getReader();
  return new ReadableStream({
    async start(controller) {
      if (!firstRead.done && firstRead.value) {
        controller.enqueue(firstRead.value);
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      } finally {
        try { reader.releaseLock(); } catch {}
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

// ============= Workflow 配置 =============

function buildWorkflowConfig(session, notionModel, useWebSearch = false) {
  return {
    type: 'workflow',
    model: notionModel || 'auto',
    enableAgentAutomations: true,
    enableAgentIntegrations: true,
    enableCustomAgents: true,
    enableExperimentalIntegrations: false,
    enableAgentDiffs: true,
    enableAgentUpdatePagePatch: true,
    enableAgentCreateDbTemplate: true,
    enableCsvAttachmentSupport: false,
    enableDatabaseAgents: false,
    showDatabaseAgentsDiscoverability: false,
    enableAgentThreadTools: false,
    enableCrdtOperations: false,
    enableAgentCardCustomization: true,
    enableSystemPromptAsPage: false,
    enableUserSessionContext: false,
    enableScriptAgentAdvanced: false,
    enableScriptAgent: true,
    enableScriptAgentSearchConnectorsInCustomAgent: false,
    enableScriptAgentGoogleDriveInCustomAgent: false,
    enableScriptAgentGoogleDriveOAuthInCustomAgent: false,
    enableScriptAgentSlack: true,
    enableScriptAgentMcpServers: false,
    enableScriptAgentMail: true,
    enableScriptAgentCalendar: true,
    enableScriptAgentCustomToolCalling: false,
    enableCreateAndRunThread: true,
    enableSoftwareFactoryPage: false,
    enableAgentGenerateImage: false,
    enableSpeculativeSearch: false,
    enableQueryCalendar: false,
    enableQueryMail: false,
    enableMailExplicitToolCalls: true,
    enableMailNotificationPreferences: false,
    enableMailAgentMultiProviderSupport: false,
    useRulePrioritization: true,
    availableConnectors: [],
    customConnectorInfo: [],
    searchScopes: useWebSearch ? [{ type: 'everything' }] : [],
    useSearchToolV2: false,
    enableUnifiedSearch: false,
    useWebSearch,
    isHipaa: false,
    yoloMode: false,
    useReadOnlyMode: false,
    writerMode: false,
    modelFromUser: !!notionModel,
    isCustomAgent: false,
    isCustomAgentBuilder: false,
    isAgentResearchRequest: false,
    useCustomAgentDraft: false,
    use_draft_actor_pointer: false,
    enableUpdatePageAutofixer: true,
    enableMarkdownVNext: false,
    enableUpdatePageOrderUpdates: true,
    enableAgentSupportPropertyReorder: true,
    agentShortUpdatePageResult: false,
    enableAgentAskSurvey: true,
    databaseAgentConfigMode: false,
    isOnboardingAgent: false,
    isMobile: false,
  };
}

// ============= buildInferencePayload — 参考 Go 项目 =============

/**
 * 构建 runInferenceTranscript 请求体
 *
 * @param {object} opts
 * @param {string} opts.prompt - 用户消息
 * @param {string} opts.model - 客户端请求的模型名
 * @param {import('./session.js').SessionInfo} opts.session
 * @param {boolean} [opts.useWebSearch]
 * @returns {object}
 */
export function buildInferencePayload({ prompt, model, session, useWebSearch = false }) {
  const threadId = uuid();
  const configId = uuid();
  const contextId = uuid();
  const notionModel = toNotionModel(model);
  const now = isoNow();

  const configValue = buildWorkflowConfig(session, notionModel, useWebSearch);

  const contextValue = {
    timezone: 'Asia/Shanghai',
    userName: session.userName,
    userId: session.userId,
    userEmail: session.email,
    spaceName: session.spaceName,
    spaceId: session.spaceId,
    currentDatetime: now,
    surface: 'ai_module',
  };

  const transcript = [
    {
      id: configId,
      type: 'config',
      value: configValue,
    },
    {
      id: contextId,
      type: 'context',
      value: contextValue,
    },
    {
      id: uuid(),
      type: 'user',
      value: [[prompt]],
      userId: session.userId,
      createdAt: now,
    },
  ];

  return {
    spaceId: session.spaceId,
    threadId,
    createThread: true,
    generateTitle: true,
    traceId: uuid(),
    transcript,
    threadType: 'workflow',
    asPatchResponse: true,
    isPartialTranscript: false,
    saveAllThreadOperations: true,
    setUnreadState: true,
    createdSource: 'ai_module',
    isUserInAnySalesAssistedSpace: false,
    isSpaceSalesAssisted: false,
    debugOverrides: {
      annotationInferences: {},
      cachedInferences: {},
      emitAgentSearchExtractedResults: true,
      emitInferences: false,
    },
    threadParentPointer: {
      table: 'space',
      id: session.spaceId,
      spaceId: session.spaceId,
    },
  };
}

// ============= OpenAI 格式处理 =============

/**
 * OpenAI 格式处理器
 * POST /v1/chat/completions
 */
export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false } = req.body;

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  // 获取 Notion 会话
  let session;
  try {
    session = getSessionInfo();
  } catch (err) {
    return res.status(503).json({ error: { message: 'Notion channel unavailable. Set NOTION_PROBE_PATH in .env' } });
  }

  const prompt = buildPromptText(messages);
  const payload = buildInferencePayload({
    prompt,
    model,
    session,
    useWebSearch: false,
  });

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const client = new NotionClient(session);

  try {
    const { body: streamBody } = await runInferenceWithFallback(client, session, payload);

    let clientGone = false;
    const onClose = () => { clientGone = true; };
    req.on('close', onClose);

    try {
      if (stream) {
        const socket = req.socket || req.connection;
        if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        writeSSE(res, {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        for await (const event of parseNotionNDJSON(streamBody)) {
          if (clientGone) break;

          if (event.type === 'content') {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            });
          } else if (event.type === 'thinking') {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            });
          } else if (event.type === 'done') {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            res.write('data: [DONE]\n\n');
            flushSSE(res);
            break;
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Notion stream error');
          }
        }
        res.end();
      } else {
        const fullContent = await consumeNotionStream(streamBody);
        if (clientGone) return;

        res.json({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: fullContent },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    } finally {
      req.off('close', onClose);
    }
  } catch (err) {
    console.error(`[Notion] Completion error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: err.message, type: 'upstream_error', code: 'notion_error' },
      });
    } else {
      try { res.end(); } catch {}
    }
  }
}

// ============= Claude 格式处理 =============

// ============= Claude 格式处理 =============

/**
 * Claude/Anthropic Messages API 格式处理器
 * POST /v1/messages
 */
export async function handleClaudeMessages(req, res) {
  const claudeReq = req.body;
  const { model, stream = false } = claudeReq;

  if (!model || !claudeReq.messages || !claudeReq.messages.length) {
    return res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'model and messages are required' },
    });
  }

  // 获取 Notion 会话
  let session;
  try {
    session = getSessionInfo();
  } catch (err) {
    return res.status(503).json({
      type: 'error',
      error: { type: 'channel_unavailable', message: 'Notion channel unavailable. Set NOTION_PROBE_PATH in .env' },
    });
  }

  // 转换为 OpenAI 格式
  let openaiReq;
  try {
    openaiReq = convertClaudeRequest(claudeReq);
  } catch (err) {
    return res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Conversion error: ${err.message}` },
    });
  }

  const prompt = buildPromptText(openaiReq.messages);
  const payload = buildInferencePayload({
    prompt,
    model,
    session,
    useWebSearch: false,
  });

  const requestId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const client = new NotionClient(session);

  try {
      const { body: streamBody } = await runInferenceWithFallback(client, session, payload);

      let clientGone = false;
      const onClose = () => { clientGone = true; };
      req.on('close', onClose);

      try {
        if (stream) {
          let fullContent = '';
          let fullThinking = '';
          let hasError = null;

          for await (const event of parseNotionNDJSON(streamBody)) {
          if (clientGone) break;
          if (event.type === 'content') fullContent += event.content;
          else if (event.type === 'thinking') fullThinking += event.content;
          else if (event.type === 'done') break;
          else if (event.type === 'error') { hasError = event.message; break; }
        }

        if (clientGone) return;
        if (hasError) throw new Error(hasError);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        writeClaudeSSE(res, {
          type: 'message_start',
          message: {
            id: requestId, type: 'message', role: 'assistant', model,
            content: [], usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        let blockIdx = 0;
        if (fullThinking) {
          writeClaudeSSE(res, {
            type: 'content_block_start', index: blockIdx,
            content_block: { type: 'text', text: '' },
          });
          writeClaudeSSE(res, {
            type: 'content_block_delta', index: blockIdx,
            delta: { type: 'text_delta', text: `[思考过程]\n${fullThinking}\n\n` },
          });
          writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        }

        writeClaudeSSE(res, {
          type: 'content_block_start', index: blockIdx,
          content_block: { type: 'text', text: '' },
        });
        writeClaudeSSE(res, {
          type: 'content_block_delta', index: blockIdx,
          delta: { type: 'text_delta', text: fullContent },
        });
        writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });

        writeClaudeSSE(res, {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 0 },
        });

        writeClaudeSSE(res, { type: 'message_stop' });
        res.end();
      } else {
        const fullContent = await consumeNotionStream(streamBody);
        if (clientGone) return;

        res.json({
          id: requestId,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: fullContent }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
    } finally {
      req.off('close', onClose);
    }
  } catch (err) {
    console.error(`[Notion Claude] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
}