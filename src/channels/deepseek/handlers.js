/**
 * DeepSeek OpenAI 格式处理器
 *
 * 从 openai.js 提取的处理逻辑
 */

import { completion, parseSSEStream } from '../../utils/sse.js';
import { resolveImageToRefId } from '../../services/upload.js';
import { enqueueRequest, dispatchQueued } from '../../services/queue.js';
import { recordTTFB, recordTokenSpeed } from '../../middleware/metrics.js';
import { getConversationId, resolveConversation, recordResponseMessageId } from '../../services/conversation.js';
import { convertClaudeRequest, convertOpenAIResponse, streamOpenAIToClaude, writeClaudeSSE } from '../../adapters/claude.js';
import { parseToolCallsFromText } from '../../utils/response-utils.js';
import { mapModel, DEEPSEEK_MODEL_MAP } from './models.js';

// Flush SSE data immediately - prevents buffering in Node.js, nginx, and Cloudflare
function flushSSE(res) {
  if (res.flush) res.flush();
  else if (res._flush) res._flush();
  const socket = res.socket || res._socket;
  if (socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
}

async function extractImages(messages, token) {
  const refFileIds = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          try {
            const fileId = await resolveImageToRefId(part.image_url.url, token);
            refFileIds.push(fileId);
          } catch (err) {
            console.error('Image upload failed:', err.message);
          }
        }
      }
    }
  }
  return refFileIds;
}

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

function toolChoiceInstruction(toolChoice, tools) {
  if (!toolChoice || toolChoice === 'auto') return 'Use a tool only when it is helpful or required to answer correctly.';
  if (toolChoice === 'required') return 'You must call at least one tool.';
  if (toolChoice === 'none') return 'Do not call tools.';
  const forcedName = toolChoice?.function?.name;
  if (forcedName && tools.some(t => t.function.name === forcedName)) {
    return `You must call the function named ${forcedName}.`;
  }
  return 'Use a tool only when it is helpful or required to answer correctly.';
}

function buildToolInstructions(tools, toolChoice) {
  const normalized = normalizeTools(tools);
  if (!normalized.length || toolChoice === 'none') return '';

  return `\n\n[Tool calling instructions]\nYou have access to these tools:\n${JSON.stringify(normalized, null, 2)}\n\n${toolChoiceInstruction(toolChoice, normalized)}\n\nIf you decide to call tools, do not answer normally. Output exactly one XML block and nothing else:\n<tool_calls>[{"name":"tool_name","arguments":{"arg":"value"}}]</tool_calls>\n\nRules:\n- The content inside <tool_calls> must be valid JSON.\n- "arguments" must be a JSON object matching the tool schema.\n- For a single tool call, still use a JSON array with one item.\n- If no tool is needed, answer normally without the <tool_calls> block.`;
}

function buildPrompt(messages, tools = [], toolChoice = 'auto') {
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      prompt += `[System]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `[User]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'assistant') {
      const content = textFromContent(msg.content);
      if (content) prompt += `[Assistant]: ${content}\n\n`;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        prompt += `[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}\n\n`;
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'function') {
      prompt += `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}\n\n`;
    }
  }
  return (prompt.trim() + buildToolInstructions(tools, toolChoice)).trim();
}

// Affinity-mode prompt: only the latest user turn (+ tool instructions), since
// DeepSeek keeps prior turns server-side via parent_message_id. Tool-calling
// instructions are still attached so the model keeps obeying tool rules.
function buildLatestPrompt(messages, tools = [], toolChoice = 'auto') {
  // Find the index of the last user message.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return buildPrompt(messages, tools, toolChoice);

  // Include everything from that last user message onward — user text, assistant
  // tool_calls, AND tool results — so DeepSeek knows the outcomes of tools it
  // requested when parent_message_id chains back to its earlier response.
  let prompt = '';
  for (let i = lastUserIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      prompt += `[User]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'assistant') {
      const content = textFromContent(msg.content);
      if (content) prompt += `[Assistant]: ${content}\n\n`;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        prompt += `[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}\n\n`;
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'function') {
      prompt += `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}\n\n`;
    }
  }

  return (prompt.trim() + buildToolInstructions(tools, toolChoice)).trim();
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeToolArguments(args) {
  // OpenAI spec: `arguments` must always be a JSON string.
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '{}';
    // If it's already valid JSON, re-stringify for canonical form.
    const parsed = tryParseJson(trimmed);
    return parsed === null ? trimmed : JSON.stringify(parsed);
  }
  // Object/number/boolean -> stringify.
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function toOpenAIToolCalls(calls) {
  return calls
    .map((call, index) => {
      const fn = call.function || call;
      const name = fn.name;
      if (!name || typeof name !== 'string') return null;
      return {
        id: call.id || `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name,
          arguments: normalizeToolArguments(fn.arguments ?? call.arguments ?? {}),
        },
      };
    })
    .filter(Boolean);
}

// Extract the JSON inside the LAST <tag>...</tag> block. Using the last closing
// tag avoids matching a stray half-opened tag that the model may have written
// inside its reasoning (e.g. "I will now emit <tool_calls>...").
function extractJsonBlock(text, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lastClose = text.toLowerCase().lastIndexOf(close);
  if (lastClose === -1) return null;
  const lastOpen = text.toLowerCase().lastIndexOf(open, lastClose);
  if (lastOpen === -1) return null;
  const inner = text.slice(lastOpen + open.length, lastClose);
  // strip any attributes on the opening tag up to '>'
  const gt = inner.indexOf('>');
  const body = gt === -1 ? inner : inner.slice(gt + 1);
  const trimmed = body.trim();
  return trimmed || null;
}

function stripToolBlocks(text) {
  return text
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

// Stream parsed tool_calls incrementally per the OpenAI streaming protocol:
// first a chunk carrying id/type/name + empty arguments, then the arguments
// string split into fixed-size deltas, so clients built for incremental
// arguments (Claude Code, LangChain) work correctly.
const ARGS_CHUNK_SIZE = 24;
function streamToolCallsIncremental(res, writeOpts, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    // Opening chunk: index, id, type, name, and empty arguments.
    writeSSE(res, {
      ...writeOpts,
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }],
    });
    const args = tc.function.arguments || '';
    for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
      writeSSE(res, {
        ...writeOpts,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }] }, finish_reason: null }],
      });
    }
  }
}

function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSSE(res);
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false, max_tokens } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = req.body.tool_choice ?? 'auto';
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const modelType = mapModel(model);
  const fullPrompt = buildPrompt(messages, tools, toolChoice);
  // Latest-turn-only prompt: used when conversation affinity engages, so the
  // upstream gets just the new user message (DeepSeek keeps the rest server-side
  // via parent_message_id). Falls back to fullPrompt when affinity is off.
  const latestPrompt = buildLatestPrompt(messages, tools, toolChoice);
  const thinkingEnabled = req.body.thinking_enabled ?? !toolCallingEnabled;
  const searchEnabled = req.body.search_enabled ?? (modelType !== 'vision');
  // Default: send thinking as separate reasoning_content field (recognized by Claude Code, OpenAI clients)
  // Set merge_thinking=true or MERGE_THINKING=true to merge into content with <arg_key> tags instead
  const mergeThinking = req.body.merge_thinking ?? (process.env.MERGE_THINKING === 'true');

  const conversationId = getConversationId(req, messages);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestStart = Date.now();
  let result;

  try {
    let refFileIds = [];
    let uploadSlot = null;
    if (modelType === 'vision') {
      uploadSlot = await enqueueRequest(true);
      try {
        refFileIds = await extractImages(messages, uploadSlot.token);
      } finally {
        uploadSlot.release();
        dispatchQueued();
      }
    }

    // Conversation affinity: resolve a DeepSeek session + parent_message_id for
    // this conversation, bound to the token that completion() acquires. The
    // prompt is selected after resolution via getPrompt (latest-only when
    // affinity engages, full history otherwise).
    const resolveSession = conversationId
      ? async (token) => {
          const r = await resolveConversation({ conversationId, modelType, token });
          return { sessionId: r.sessionId, parentMessageId: r.parentMessageId, affinity: r.affinity };
        }
      : null;
    const getPrompt = (affinity) => affinity ? latestPrompt : fullPrompt;

    result = await completion({ modelType, prompt: fullPrompt, thinkingEnabled, searchEnabled, refFileIds, preferVision: modelType === 'vision', resolveSession, getPrompt });
  } catch (err) {
    console.error('Completion error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  // Detect client disconnect so we can cancel the upstream stream and release
  // the token slot instead of blocking on parseSSEStream until upstream ends.
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    try { streamBody.cancel(); } catch {}
  };
  req.on('close', onClose);

  try {
    if (stream) {
      // Set TCP_NODELAY on the socket immediately to prevent Nagle buffering
      const _socket = req.socket || req.connection;
      if (_socket && typeof _socket.setNoDelay === "function") _socket.setNoDelay(true);
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

      let inThinkingPhase = thinkingEnabled;
      let thinkingTagOpened = false;
      let firstChunkTime = null;
      let streamUsage = 0;
      // When tool-calling, content (model output) is buffered until the stream
      // ends so we can parse <tool_calls> blocks. Thinking stays separate and is
      // streamed live (see below) so reasoning never leaks into `content`.
      let contentBuffer = '';

      for await (const event of parseSSEStream(streamBody)) {
        if (clientGone) break;
        if (event.type === 'error') {
          if (event.code === 40004) {
            console.error(`Account BANNED in stream: ${slot.token.slice(0, 12)}...`);
          }
          throw new Error(event.message || `DeepSeek error ${event.code}`);
        }
        if (event.messageIds?.responseMessageId) {
          recordResponseMessageId(conversationId, event.messageIds.responseMessageId);
        }
        if (event.type === 'content') {
          if (toolCallingEnabled) {
            // Buffer model output; do NOT touch inThinkingPhase here so that
            // any interleaved thinking events keep streaming as reasoning_content.
            contentBuffer += event.content;
            continue;
          }
          if (mergeThinking && thinkingTagOpened) {
            thinkingTagOpened = false;
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: '\n</think>\n' }, finish_reason: null }],
            });
          }
          inThinkingPhase = false;
          writeSSE(res, {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          });
        } else if (event.type === 'thinking') {
          if (toolCallingEnabled) {
            // Stream reasoning live as reasoning_content; never mix it into
            // contentBuffer (which is the tool-call source) so thinking cannot
            // leak into the returned `content` or corrupt tool-call parsing.
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            });
            continue;
          }
          if (!inThinkingPhase) continue;
          if (mergeThinking) {
            if (!thinkingTagOpened) {
              thinkingTagOpened = true;
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { content: '<think>\n' }, finish_reason: null }],
              });
            }
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            });
          } else {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            });
          }
        } else if (event.type === 'usage') {
          streamUsage = event.usage;
        } else if (event.type === 'done') {
          if (mergeThinking && thinkingTagOpened) {
            thinkingTagOpened = false;
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: '\n</think>\n' }, finish_reason: null }],
            });
          }

          const writeOpts = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
          };

          const parsedToolCalls = toolCallingEnabled ? parseToolCallsFromText(contentBuffer) : null;
          if (parsedToolCalls?.toolCalls?.length) {
            // Send any text content appearing before <tool_calls> so the client
            // sees the model's intermediate reasoning (e.g. "Let me check...").
            if (parsedToolCalls.content) {
              writeSSE(res, {
                ...writeOpts,
                choices: [{ index: 0, delta: { content: parsedToolCalls.content }, finish_reason: null }],
              });
            }
            // Emit tool_calls with incremental arguments chunks, then finish.
            streamToolCallsIncremental(res, writeOpts, parsedToolCalls.toolCalls);
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            });
          } else {
            // No tool call: fall back to a normal response using buffered output.
            if (toolCallingEnabled && contentBuffer) {
              writeSSE(res, {
                ...writeOpts,
                choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }],
              });
            }
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
          }
          res.write('data: [DONE]\n\n');
          flushSSE(res);
          // Record token speed at stream end
          const streamDuration = Date.now() - requestStart;
          if (streamUsage > 0 && streamDuration > 0) {
            recordTokenSpeed(model, streamUsage, streamDuration);
          }
          break; // Exit SSE loop — done event is the final signal
        }
      }
      res.end();
    } else {
      let fullContent = '';
      let fullThinking = '';
      let usage = 0;
      let inThinkingPhase = thinkingEnabled;

      for await (const event of parseSSEStream(streamBody)) {
        if (clientGone) break;
        if (event.type === 'error') {
          if (event.code === 40004) {
            console.error(`Account BANNED in stream: ${slot.token.slice(0, 12)}...`);
          }
          throw new Error(event.message || `DeepSeek error ${event.code}`);
        }
        if (event.messageIds?.responseMessageId) {
          recordResponseMessageId(conversationId, event.messageIds.responseMessageId);
        }
        if (event.type === 'content') {
          fullContent += event.content;
          inThinkingPhase = false;
        } else if (event.type === 'thinking' && inThinkingPhase) {
          fullThinking += event.content;
        } else if (event.type === 'usage') usage = event.usage;
      }

      // Record TTFB and token speed for non-streaming
      const totalDuration = Date.now() - requestStart;
      recordTTFB(model, totalDuration);
      if (usage > 0 && totalDuration > 0) {
        recordTokenSpeed(model, usage, totalDuration);
      }

      // Parse tool calls only from model output, never from thinking. Thinking
      // leaking into the parse source caused tool-call misfires and exposed
      // reasoning in `content`.
      const parsedToolCalls = toolCallingEnabled ? parseToolCallsFromText(fullContent) : null;
      const message = parsedToolCalls?.toolCalls?.length
        ? {
            role: 'assistant',
            content: parsedToolCalls.content || null,
            tool_calls: parsedToolCalls.toolCalls,
            ...((!mergeThinking && fullThinking) ? { reasoning_content: fullThinking } : {}),
          }
        : {
            role: 'assistant',
            content: mergeThinking && fullThinking
              ? `<think>\n${fullThinking}\n</think>\n${fullContent}`
              : fullContent,
            ...((!mergeThinking && fullThinking) ? { reasoning_content: fullThinking } : {}),
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
          completion_tokens: usage,
          total_tokens: usage,
        },
      };
      res.json(response);
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    req.off('close', onClose);
    slot.release();
    dispatchQueued();
  }
}

export function handleOpenAIModels(req, res) {
  res.json({
    object: 'list',
    data: Object.keys(DEEPSEEK_MODEL_MAP).map((id, i) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'deepseek',
    })),
  });
}

/**
 * DeepSeek + Claude 格式处理器（支持流式和非流式）
 * 使用自建 Token 池（chat.deepseek.com）- 免费 Web 版
 * POST /deepseek/v1/messages
 */
export async function handleDeepSeekClaude(req, res) {
  try {
    const claudeReq = req.body;
    const { model, messages, stream = false } = claudeReq;

    if (!model || !messages || !messages.length) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'model and messages are required'
        }
      });
    }

    // 1. 转换 Claude 请求为 OpenAI 格式
    const openaiReq = convertClaudeRequest(claudeReq);

    // 2. 映射模型
    const modelType = mapModel(model);

    // 3. 构建提示词（使用 OpenAI 处理器中的函数）
    const tools = normalizeTools(openaiReq.tools);
    const toolChoice = openaiReq.tool_choice ?? 'auto';
    const fullPrompt = buildPrompt(openaiReq.messages, tools, toolChoice);
    const thinkingEnabled = true;
    const searchEnabled = modelType !== 'vision';

    const requestId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 4. 调用自建系统（使用 Token 池 + chat.deepseek.com）
    const result = await completion({
      modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds: [],
      preferVision: modelType === 'vision',
    });

    const { body: streamBody, slot } = result;

    // 监听客户端断开
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      try { streamBody.cancel(); } catch {}
    };
    req.on('close', onClose);

    try {
      if (stream) {
        // 流式响应：先缓冲所有内容，结束时解析工具调用再按序输出
        // 注意：必须先消费完 streamBody 才能 writeHead，避免 headers 已发送却出错

        let contentBuffer = '';
        let thinkingBuffer = '';
        let hasStreamError = null;

        for await (const event of parseSSEStream(streamBody)) {
          if (clientGone) break;

          if (event.type === 'content' && event.content) {
            contentBuffer += event.content;
          } else if (event.type === 'thinking' && event.content) {
            thinkingBuffer += event.content;
          } else if (event.type === 'done') {
            break;
          } else if (event.type === 'error') {
            hasStreamError = event.message || 'DeepSeek stream error';
            break;
          }
        }

        if (clientGone) return;
        if (hasStreamError) throw new Error(hasStreamError);

        // 现在才发送 response headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // 解析工具调用
        const parsed = parseToolCallsFromText(contentBuffer);
        const hasValidToolCalls = parsed?.toolCalls?.length;

        // 发送 message_start
        writeClaudeSSE(res, {
          type: 'message_start',
          message: {
            id: requestId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        if (hasValidToolCalls) {
          // 有工具调用

          // 先输出文本 block（工具调用之前的 assistant 回复）
          let blockIdx = 0;
          if (parsed.content) {
            writeClaudeSSE(res, {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
            writeClaudeSSE(res, {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: parsed.content },
            });
            writeClaudeSSE(res, { type: 'content_block_stop', index: 0 });
            blockIdx = 1;
          }

          // 输出 tool_use blocks
          for (const tc of parsed.toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

            writeClaudeSSE(res, {
              type: 'content_block_start',
              index: blockIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id || `toolu_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                name: tc.function.name,
              },
            });

            const argsJson = JSON.stringify(args);
            if (argsJson) {
              writeClaudeSSE(res, {
                type: 'content_block_delta',
                index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: argsJson },
              });
            }

            writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
            blockIdx++;
          }

          writeClaudeSSE(res, {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 0 },
          });
        } else {
          // 无工具调用：纯文本
          let blockIdx = 0;

          if (thinkingBuffer) {
            writeClaudeSSE(res, {
              type: 'content_block_start',
              index: blockIdx,
              content_block: { type: 'text', text: '' },
            });
            writeClaudeSSE(res, {
              type: 'content_block_delta',
              index: blockIdx,
              delta: { type: 'text_delta', text: `[思考过程]\n${thinkingBuffer}\n\n` },
            });
            writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
            blockIdx++;
          }

          writeClaudeSSE(res, {
            type: 'content_block_start',
            index: blockIdx,
            content_block: { type: 'text', text: '' },
          });
          writeClaudeSSE(res, {
            type: 'content_block_delta',
            index: blockIdx,
            delta: { type: 'text_delta', text: contentBuffer },
          });
          writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });

          writeClaudeSSE(res, {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0 },
          });
        }

        writeClaudeSSE(res, { type: 'message_stop' });
        res.end();
      } else {
        // 非流式响应：收集完整响应
        let fullText = '';
        let fullThinking = '';
        for await (const event of parseSSEStream(streamBody)) {
          if (clientGone) break;
          if (event.type === 'content' && event.content) {
            fullText += event.content;
          }
          if (event.type === 'thinking' && event.content) {
            fullThinking += event.content;
          }
        }

        // 解析工具调用
        const parsed = parseToolCallsFromText(fullText);
        const hasValidToolCalls = parsed?.toolCalls?.length;

        let claudeResp;
        if (hasValidToolCalls) {
          // 有工具调用 → 构建包含 tool_use 的响应
          const contentBlocks = [];

          // 文本部分（工具调用之前的 assistant 回复）
          if (parsed.content) {
            contentBlocks.push({ type: 'text', text: parsed.content });
          }
          if (fullThinking) {
            contentBlocks.push({ type: 'text', text: `[思考过程]\n${fullThinking}` });
          }

          // 工具调用
          for (const tc of parsed.toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id || `toolu_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              name: tc.function.name,
              input: args,
            });
          }

          claudeResp = {
            id: requestId,
            type: 'message',
            role: 'assistant',
            model,
            content: contentBlocks,
            stop_reason: 'tool_use',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        } else {
          // 无工具调用 → 纯文本响应
          claudeResp = {
            id: requestId,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: fullText }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        }

        res.json(claudeResp);
      }
    } finally {
      req.off('close', onClose);
      if (slot && slot.release) slot.release();
      dispatchQueued();
    }

  } catch (err) {
    console.error('[DeepSeek Claude] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: err.message,
        },
      });
    }
  }
}

/**
 * DeepSeek 模型列表
 * GET /deepseek/v1/models
 */
export function handleDeepSeekModels(req, res) {
  res.json({
    object: 'list',
    data: Object.keys(DEEPSEEK_MODEL_MAP).map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'deepseek',
    })),
  });
}
