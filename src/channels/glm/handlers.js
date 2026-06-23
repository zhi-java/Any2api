/**
 * GLM Express 请求处理器
 *
 * 处理 OpenAI 和 Claude 格式的请求，转换为 GLM API 调用
 */

import { convertMessages, buildPrompt, glmChatCompletion, parseToolCallsFromText } from './client.js';
import { parseGLMStream } from './stream-parser.js';
import { resolveModel } from './models.js';
import { convertClaudeRequest, convertOpenAIResponse, streamOpenAIToClaude, writeClaudeSSE } from '../../adapters/claude.js';

// ============================================================
// 工具调用支持
// ============================================================

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t?.type === 'function' && t.function?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

// ============================================================
// SSE 辅助
// ============================================================

function flushSSE(res) {
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSSE(res);
}

// ============================================================
// 请求处理器
// ============================================================

/**
 * POST /v1/chat/completions (OpenAI 格式)
 * GLM 渠道处理器
 */
export async function handleGLMOpenAI(req, res, tokenManager) {
  const { model, messages, stream = false, max_tokens } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = req.body.tool_choice ?? 'auto';
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const modelConfig = resolveModel(model);
  const conversationId = req.headers['x-conversation-id'] || '';

  const requestId = `glm-chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestStart = Date.now();

  // 构建完整 prompt（含工具定义）
  const fullPrompt = buildPrompt(messages, tools);
  const glmMessages = convertMessages(messages);

  try {
    // 调用 GLM API
    const streamBody = await glmChatCompletion(glmMessages, {
      assistantId: modelConfig.assistantId,
      plusModel: modelConfig.plusModel,
      searchEnabled: modelConfig.search,
      conversationId,
      tokenManager,
    });

    // 检测客户端断开
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      try { streamBody.cancel(); } catch {}
    };
    req.on('close', onClose);

    try {
      if (stream) {
        await handleStreamingResponse(req, res, streamBody, {
          requestId, model, toolCallingEnabled, requestStart,
        });
      } else {
        await handleNonStreamingResponse(req, res, streamBody, {
          requestId, model, toolCallingEnabled, requestStart,
        });
      }
    } finally {
      req.off('close', onClose);
    }
  } catch (err) {
    console.error('[GLM] Completion error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  }
}

/**
 * 流式响应处理
 */
async function handleStreamingResponse(req, res, streamBody, { requestId, model, toolCallingEnabled, requestStart }) {
  const _socket = req.socket || req.connection;
  if (_socket && typeof _socket.setNoDelay === 'function') _socket.setNoDelay(true);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 初始 chunk
  writeSSE(res, {
    id: requestId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  let contentBuffer = '';
  let inThinkingPhase = false;

  for await (const event of parseGLMStream(streamBody)) {
    if (req.clientGone) break;

    switch (event.type) {
      case 'content': {
        if (toolCallingEnabled) {
          contentBuffer += event.content;
          continue;
        }
        inThinkingPhase = false;
        writeSSE(res, {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
        });
        break;
      }

      case 'thinking': {
        writeSSE(res, {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
        });
        break;
      }

      case 'tool_calls': {
        // 工具调用 — 直接输出
        const tc = event.toolCalls;
        if (Array.isArray(tc)) {
          const ARGS_CHUNK_SIZE = 24;
          for (let i = 0; i < tc.length; i++) {
            const call = tc[i];
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{
                index: 0, delta: {
                  tool_calls: [{
                    index: i, id: call.id, type: 'function',
                    function: { name: call.function.name, arguments: '' },
                  }],
                }, finish_reason: null,
              }],
            });
            const args = call.function.arguments || '';
            for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{
                  index: 0, delta: {
                    tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }],
                  }, finish_reason: null,
                }],
              });
            }
          }
          writeSSE(res, {
            id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          });
        }
        break;
      }

      case 'image': {
        // CogView 图片生成
        writeSSE(res, {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{
            index: 0, delta: { content: `![Generated Image](${event.imageUrl})` }, finish_reason: null,
          }],
        });
        break;
      }

      case 'error': {
        console.error('[GLM] Stream error:', event.message);
        throw new Error(event.message);
      }

      case 'done': {
        // 工具调用模式：从 buffer 解析
        if (toolCallingEnabled && contentBuffer) {
          const parsed = parseToolCallsFromText(contentBuffer);
          if (parsed?.toolCalls?.length) {
            if (parsed.content) {
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { content: parsed.content }, finish_reason: null }],
              });
            }
            // 增量式工具调用
            const ARGS_CHUNK_SIZE = 24;
            for (let i = 0; i < parsed.toolCalls.length; i++) {
              const call = parsed.toolCalls[i];
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{
                  index: 0, delta: {
                    tool_calls: [{
                      index: i, id: call.id, type: 'function',
                      function: { name: call.function.name, arguments: '' },
                    }],
                  }, finish_reason: null,
                }],
              });
              const args = call.function.arguments || '';
              for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
                writeSSE(res, {
                  id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                  choices: [{
                    index: 0, delta: {
                      tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }],
                    }, finish_reason: null,
                  }],
                });
              }
            }
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            });
          } else {
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }],
            });
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
          }
        } else {
          writeSSE(res, {
            id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
        }
        res.write('data: [DONE]\n\n');
        flushSSE(res);
        return; // 结束
      }

      case 'usage': {
        // usage 信息，在非流式响应中使用
        break;
      }
    }
  }

  // 流意外结束
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    flushSSE(res);
    res.end();
  }
}

/**
 * 非流式响应处理
 */
async function handleNonStreamingResponse(req, res, streamBody, { requestId, model, toolCallingEnabled, requestStart }) {
  let fullContent = '';
  let fullThinking = '';
  let usage = 0;
  let inThinkingPhase = false;

  for await (const event of parseGLMStream(streamBody)) {
    if (req.clientGone) break;

    switch (event.type) {
      case 'content':
        fullContent += event.content;
        inThinkingPhase = false;
        break;
      case 'thinking':
        if (!inThinkingPhase) break;
        fullThinking += event.content;
        break;
      case 'tool_calls':
        fullContent += JSON.stringify(event.toolCalls);
        break;
      case 'usage':
        if (typeof event.usage === 'number') usage = event.usage;
        break;
      case 'error':
        throw new Error(event.message);
      case 'done':
        break;
    }
  }

  // 解析工具调用
  const mergeThinking = process.env.MERGE_THINKING === 'true';
  const parsedToolCalls = toolCallingEnabled ? parseToolCallsFromText(fullContent) : null;
  const message = parsedToolCalls?.toolCalls?.length
    ? {
        role: 'assistant',
        content: parsedToolCalls.content || null,
        tool_calls: parsedToolCalls.toolCalls,
      }
    : {
        role: 'assistant',
        content: mergeThinking && fullThinking
          ? `<think>\n${fullThinking}\n</think>\n${fullContent}`
          : fullContent,
        ...(fullThinking ? { reasoning_content: fullThinking } : {}),
      };

  const response = {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: parsedToolCalls?.toolCalls?.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: usage || Math.round((fullContent.length + fullThinking.length) / 4),
      total_tokens: usage || Math.round((fullContent.length + fullThinking.length) / 4),
    },
  };

  res.json(response);
}

/**
 * POST /v1/messages (Claude 格式)
 * GLM 渠道处理器
 */
export async function handleGLMClaude(req, res, tokenManager) {
  try {
    const claudeReq = req.body;

    // 1. 转换请求格式
    const openaiReq = convertClaudeRequest(claudeReq);

    // 2. 构建 GLM 消息
    const glmMessages = convertMessages(openaiReq.messages);
    const modelConfig = resolveModel(claudeReq.model);

    // 3. 调用 GLM API
    const streamBody = await glmChatCompletion(glmMessages, {
      assistantId: modelConfig.assistantId,
      plusModel: modelConfig.plusModel,
      searchEnabled: modelConfig.search,
      conversationId: '',
      tokenManager,
    });

    // 4. 根据类型处理响应
    if (claudeReq.stream) {
      // 流式响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // 转换 GLM 流为 Claude 格式
      try {
        let fullContent = '';
        const requestId = `msg_${Date.now().toString(36)}`;

        for await (const event of parseGLMStream(streamBody)) {
          if (res.writableEnded) break;

          switch (event.type) {
            case 'content':
              fullContent += event.content;
              writeClaudeSSE(res, {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: event.content },
              });
              break;
            case 'done':
              writeClaudeSSE(res, {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: Math.round(fullContent.length / 4) },
              });
              writeClaudeSSE(res, { type: 'message_stop' });
              break;
            case 'error':
              writeClaudeSSE(res, {
                type: 'error',
                error: { type: 'api_error', message: event.message },
              });
              break;
          }
        }
        res.end();
      } catch (streamErr) {
        console.error('[GLM Claude] Stream error:', streamErr.message);
        if (!res.writableEnded) {
          writeClaudeSSE(res, {
            type: 'error',
            error: { type: 'api_error', message: streamErr.message },
          });
          res.end();
        }
      }
    } else {
      // 非流式响应
      let fullContent = '';

      for await (const event of parseGLMStream(streamBody)) {
        if (event.type === 'content') {
          fullContent += event.content;
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }

      const claudeResp = {
        id: `msg_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: fullContent }],
        model: claudeReq.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: Math.round(fullContent.length / 4),
        },
      };

      res.json(claudeResp);
    }

  } catch (err) {
    console.error('[GLM Claude] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
}
