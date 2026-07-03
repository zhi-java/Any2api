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
import {
  buildToolInstructions as buildSharedToolInstructions,
  buildToolRetryPrompt,
  createJsonContentExtractor,
  detectFailedToolParse,
  extractAssistantResponse,
  looksLikeMalformedToolOutput,
  normalizeTools as normalizeSharedTools,
  normalizeJsonEscapedText,
  parseToolCallsFromText,
  sanitizePathMentions,
  validateToolCallsPipeline,
} from '../../utils/response-utils.js';
import { mapModel, DEEPSEEK_MODEL_MAP } from './models.js';
import {
  createRuntimeContextFallbackPlan,
  DEEPSEEK_FLASH_MODEL,
  isContextFallbackEnabled,
  isContextLimitError,
  isDeepSeekProModel,
  selectContextExecutionPlan,
} from './context-budget.js';

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
  if (typeof content === 'string') return sanitizePathMentions(normalizeJsonEscapedText(content));
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return sanitizePathMentions(normalizeJsonEscapedText(part.text || ''));
      if (part.type === 'image_url') return '[Image]';
      return sanitizePathMentions(JSON.stringify(part));
    }).filter(Boolean).join('\n');
  }
  if (content.type === 'text' && typeof content.text === 'string') {
    return sanitizePathMentions(normalizeJsonEscapedText(content.text));
  }
  return sanitizePathMentions(JSON.stringify(content));
}

const MAX_TOOL_RESULT_BYTES = parseInt(process.env.MAX_TOOL_RESULT_BYTES || String(200 * 1024), 10);
const TOOL_RESULT_COMPACT_TARGET_BYTES = Math.max(4096, MAX_TOOL_RESULT_BYTES - 8192);

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function tryParseToolJson(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function tableNameOf(table) {
  if (!table || typeof table !== 'object') return null;
  return table.name || table.table_name || table.tableName || table.TABLE_NAME || table.table || table.id || null;
}

function tableColumnsOf(table) {
  if (!table || typeof table !== 'object') return [];
  const columns = table.columns || table.fields || table.cols || table.column_list || table.children || [];
  if (!Array.isArray(columns)) return [];
  return columns.map(col => {
    if (!col || typeof col !== 'object') return { name: String(col) };
    return {
      name: col.name || col.column_name || col.columnName || col.FIELD || col.id || null,
      type: col.type || col.data_type || col.dataType || col.COLUMN_TYPE || null,
      nullable: col.nullable ?? col.is_nullable ?? undefined,
      primary_key: col.primary_key ?? col.primaryKey ?? col.pk ?? undefined,
    };
  }).filter(col => col.name || col.type);
}

function collectTableArrays(value, out = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    const named = value.filter(item => tableNameOf(item));
    if (named.length >= Math.max(1, Math.ceil(value.length * 0.5))) out.push(named);
    for (const item of value) collectTableArrays(item, out, seen, depth + 1);
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && /tables?|relations?|entities?/i.test(key)) {
      const named = child.filter(item => tableNameOf(item));
      if (named.length) out.push(named);
    }
    collectTableArrays(child, out, seen, depth + 1);
  }
  return out;
}

function compactSchemaToolResult(parsed, toolName, originalBytes) {
  const tableArrays = collectTableArrays(parsed);
  if (!tableArrays.length) return null;

  const tables = tableArrays.sort((a, b) => b.length - a.length)[0];
  const compact = {
    _compressed_tool_result: true,
    tool: toolName,
    reason: `Tool result compressed because original size ${originalBytes} bytes exceeds ${MAX_TOOL_RESULT_BYTES} bytes.`,
    table_count: tables.length,
    table_names: tables.map(tableNameOf).filter(Boolean),
    tables: tables.map(table => {
      const columns = tableColumnsOf(table);
      return {
        name: tableNameOf(table),
        column_count: columns.length,
        columns: columns.slice(0, 30),
      };
    }),
  };

  let text = JSON.stringify(compact);
  if (byteLength(text) <= TOOL_RESULT_COMPACT_TARGET_BYTES) return text;

  // Very large schemas: preserve exact count and table names, drop column details first.
  const noColumns = {
    ...compact,
    tables: tables.map(table => ({ name: tableNameOf(table), column_count: tableColumnsOf(table).length })),
  };
  text = JSON.stringify(noColumns);
  if (byteLength(text) <= TOOL_RESULT_COMPACT_TARGET_BYTES) return text;

  // Extremely many tables: preserve exact count and a bounded sample.
  const sampled = {
    _compressed_tool_result: true,
    tool: toolName,
    reason: `Tool result compressed because original size ${originalBytes} bytes exceeds ${MAX_TOOL_RESULT_BYTES} bytes.`,
    table_count: tables.length,
    table_names_sample: tables.map(tableNameOf).filter(Boolean).slice(0, 1000),
    note: 'Table count is exact; table_names_sample is truncated to fit the DeepSeek Web input limit.',
  };
  return truncateUtf8(JSON.stringify(sampled), TOOL_RESULT_COMPACT_TARGET_BYTES);
}

function compressToolResultContent(content, toolName = 'tool') {
  const text = textFromContent(content);
  const originalBytes = byteLength(text);
  if (originalBytes <= MAX_TOOL_RESULT_BYTES) return text;

  const parsed = tryParseToolJson(text);
  const compactSchema = compactSchemaToolResult(parsed, toolName, originalBytes);
  if (compactSchema) return compactSchema;

  const prefixBudget = Math.max(1024, TOOL_RESULT_COMPACT_TARGET_BYTES - 512);
  return JSON.stringify({
    _compressed_tool_result: true,
    tool: toolName,
    reason: `Tool result truncated because original size ${originalBytes} bytes exceeds ${MAX_TOOL_RESULT_BYTES} bytes.`,
    original_bytes: originalBytes,
    returned_prefix_bytes: prefixBudget,
    content_prefix: truncateUtf8(text, prefixBudget),
  });
}

function normalizeTools(tools) {
  return normalizeSharedTools(tools);
}

function buildToolInstructions(tools, toolChoice) {
  return buildSharedToolInstructions(tools, toolChoice);
}

function findToolCallName(messages, beforeIndex, toolCallId) {
  if (!toolCallId) return null;
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const calls = messages[i]?.tool_calls;
    if (!Array.isArray(calls)) continue;
    const matched = calls.find(tc => tc?.id === toolCallId);
    if (matched?.function?.name) return matched.function.name;
  }
  return null;
}

function toolResultLabel(messages, index, msg) {
  const id = msg.tool_call_id || '';
  const name = msg.name || findToolCallName(messages, index, id) || id || 'tool';
  return id && name !== id ? `${name} (${id})` : name;
}

function renderPromptRange(messages, startIdx, endIdx) {
  let prompt = '';
  let hasToolResult = false;
  for (let i = startIdx; i < endIdx; i++) {
    const msg = messages[i];
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
      const name = toolResultLabel(messages, i, msg);
      prompt += `[Tool result ${name}]: ${compressToolResultContent(msg.content, name)}\n\n`;
      hasToolResult = true;
    } else if (msg.role === 'function') {
      const name = msg.name || 'function';
      prompt += `[Function result ${name}]: ${compressToolResultContent(msg.content, name)}\n\n`;
      hasToolResult = true;
    }
  }
  if (hasToolResult) {
    prompt += `[Tool result instruction]: 上面是客户端已经执行工具后返回的真实结果。请基于这些工具结果继续完成用户请求；不要忽略工具结果，也不要重复调用已经得到充分结果的同一个工具。如果无需继续调用工具，必须在 assistant_response 中反馈已完成的操作、关键结果和验证情况，禁止空回复结束多轮任务。\n\n`;
  }
  return prompt;
}

function buildPrompt(messages, tools = [], toolChoice = 'auto') {
  return (renderPromptRange(messages, 0, messages.length).trim() + buildToolInstructions(tools, toolChoice)).trim();
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
  return (renderPromptRange(messages, lastUserIdx, messages.length).trim() + buildToolInstructions(tools, toolChoice)).trim();
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
    .replace(/<_calls\b[^>]*>[\s\S]*?<\/_calls>/gi, '')
    .replace(/<_calls\b[^>]*>\s*\[/gi, '')
    .trim();
}

function hasToolCallMarkup(text) {
  return /<\/?(?:tool_calls|tool_call|_calls)\b/i.test(String(text || ''));
}

function parseValidatedToolCalls({ contentBuffer = '', toolParseBuffer = '', toolCallingEnabled = false, toolChoice = 'auto', tools = [], logPrefix = 'DeepSeek tools' }) {
  if (!toolCallingEnabled) return { toolCalls: null, content: null, toolCallsFromThinking: false };

  const parsedFromContent = parseToolCallsFromText(contentBuffer);
  const shouldParseCombined = !parsedFromContent?.toolCalls?.length && toolParseBuffer && toolParseBuffer !== contentBuffer;
  const parsedFromAny = shouldParseCombined ? parseToolCallsFromText(toolParseBuffer) : null;
  const parsed = parsedFromContent?.toolCalls?.length
    ? parsedFromContent
    : (parsedFromAny?.toolCalls?.length ? parsedFromAny : (parsedFromContent || parsedFromAny));
  const toolCallsFromThinking = parsed === parsedFromAny;
  const rawToolCalls = parsed?.toolCalls?.length ? parsed.toolCalls : null;

  const { toolCalls, warning } = validateToolCallsPipeline(rawToolCalls, toolChoice, tools);
  if (warning) console.warn(`[${logPrefix}] ${warning}`);

  const parseWarning = detectFailedToolParse(contentBuffer || toolParseBuffer, toolCallingEnabled);
  if (parseWarning && !toolCalls?.length) console.warn(`[${logPrefix}] ${parseWarning}`);

  return {
    toolCalls,
    content: parsed?.content || null,
    toolCallsFromThinking,
  };
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

function writeOpenAISSEDone(res) {
  res.write('data: [DONE]\n\n');
  flushSSE(res);
}

function setContextPlanHeaders(res, plan) {
  if (!plan || res.headersSent) return;
  res.setHeader('X-DeepSeek-Effective-Model', plan.effectiveModel);
  res.setHeader('X-DeepSeek-Estimated-Prompt-Tokens', String(plan.estimatedPromptTokens));
  res.setHeader('X-DeepSeek-Pro-Safe-Input-Tokens', String(plan.safeInputTokens));
  if (plan.fallbackReason) {
    res.setHeader('X-DeepSeek-Fallback-Reason', plan.fallbackReason);
  }
}

function logContextFallback(plan) {
  if (!plan?.fallbackReason) return;
  console.warn(
    `[DeepSeek context] ${plan.requestedModel} -> ${plan.effectiveModel} ` +
    `(${plan.fallbackReason}; estimated=${plan.estimatedPromptTokens}; safe=${plan.safeInputTokens})`
  );
}

async function completionWithContextFallback(initialPlan, buildArgs) {
  let plan = initialPlan;
  logContextFallback(plan);

  try {
    const result = await completion(buildArgs(plan));
    return { result, plan };
  } catch (err) {
    if (
      !plan.fallbackReason &&
      isContextFallbackEnabled() &&
      isDeepSeekProModel(plan.requestedModel) &&
      isContextLimitError(err)
    ) {
      plan = createRuntimeContextFallbackPlan(plan);
      logContextFallback(plan);
      const result = await completion(buildArgs(plan));
      return { result, plan };
    }
    throw err;
  }
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
  const thinkingEnabled = req.body.thinking_enabled ?? true;
  const searchEnabled = req.body.search_enabled ?? true;
  // Default: send thinking as separate reasoning_content field (recognized by Claude Code, OpenAI clients)
  // Set merge_thinking=true or MERGE_THINKING=true to merge into content with <arg_key> tags instead
  const mergeThinking = req.body.merge_thinking ?? (process.env.MERGE_THINKING === 'true');

  const conversationId = getConversationId(req, messages);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestStart = Date.now();
  let result;
  let contextPlan = selectContextExecutionPlan({
    requestedModel: model,
    requestedModelType: modelType,
    promptForBudget: conversationId ? latestPrompt : fullPrompt,
  });

  try {
    let refFileIds = [];
    // v4-flash 支持上传图片/PDF；只在消息含图片时获取 upload slot
    if (contextPlan.effectiveModel === DEEPSEEK_FLASH_MODEL && messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))) {
      const uploadSlot = await enqueueRequest(true);
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
    const makeResolveSession = (activeModelType) => conversationId
      ? async (token) => {
          const r = await resolveConversation({ conversationId, modelType: activeModelType, token });
          return { sessionId: r.sessionId, parentMessageId: r.parentMessageId, affinity: r.affinity };
        }
      : null;
    const getPrompt = (affinity) => affinity ? latestPrompt : fullPrompt;

    const completionResult = await completionWithContextFallback(contextPlan, (activePlan) => ({
      modelType: activePlan.modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds,
      preferVision: activePlan.effectiveModel === DEEPSEEK_FLASH_MODEL,
      resolveSession: makeResolveSession(activePlan.modelType),
      getPrompt,
    }));
    result = completionResult.result;
    contextPlan = completionResult.plan;
    setContextPlanHeaders(res, contextPlan);
  } catch (err) {
    console.error('Completion error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;
  const responseModel = contextPlan.effectiveModel || model;

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
        model: responseModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      let inThinkingPhase = thinkingEnabled;
      let thinkingTagOpened = false;
      let firstChunkTime = null;
      let streamUsage = 0;
      // 使用增量 JSON 提取器，实时提取 assistant_response 文本流式输出
      const jsonExtractor = createJsonContentExtractor();
      let rawContentBuffer = '';
      // 缓冲增量提取的文本，累积到一定量再输出，避免逐字符 SSE 事件
      let contentFlushBuffer = '';
      let streamedContent = false;
      const CONTENT_FLUSH_THRESHOLD = 20;
      // 部分 DeepSeek 变体可能在 THINK 片段中输出工具标签
      let toolParseBuffer = '';
      let streamDoneReceived = false;
      const writeOpts = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
      };

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
          rawContentBuffer += event.content;
          if (!toolCallingEnabled) {
            writeSSE(res, { ...writeOpts, choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }] });
            streamedContent = true;
            continue;
          }

          // 增量提取 assistant_response 文本，实时流式输出
          // 模型输出格式：{"assistant_response": "...", "tool_calls": [...]}
          const delta = jsonExtractor.process(event.content);
          if (delta) {
            contentFlushBuffer += delta;
            // 累积到阈值或值结束时批量输出，避免逐字符 SSE 事件
            if (contentFlushBuffer.length >= CONTENT_FLUSH_THRESHOLD || jsonExtractor.isDone()) {
              if (mergeThinking && thinkingTagOpened) {
                thinkingTagOpened = false;
                writeSSE(res, { ...writeOpts, choices: [{ index: 0, delta: { content: '\n response\n' }, finish_reason: null }] });
              }
              writeSSE(res, { ...writeOpts, choices: [{ index: 0, delta: { content: contentFlushBuffer }, finish_reason: null }] });
              streamedContent = true;
              contentFlushBuffer = '';
            }
          }
          continue;
        } else if (event.type === 'thinking') {
          if (toolCallingEnabled) {
            // Keep a parse-only copy so tool tags emitted in THINK fragments can
            // still become protocol-level tool_calls. Do not stream those tag
            // fragments live: weak models can loop on bare <tool_calls> tokens and
            // otherwise flood web clients before final parsing can clean them.
            toolParseBuffer += event.content;
            if (!hasToolCallMarkup(event.content)) {
              writeSSE(res, {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: responseModel,
                choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
              });
            }
            continue;
          }
          if (!inThinkingPhase) continue;
          if (mergeThinking) {
            if (!thinkingTagOpened) {
              thinkingTagOpened = true;
              writeSSE(res, {
                id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: responseModel,
                choices: [{ index: 0, delta: { content: '<think>\n' }, finish_reason: null }],
              });
            }
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: responseModel,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            });
          } else {
            writeSSE(res, {
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: responseModel,
              choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
            });
          }
        } else if (event.type === 'usage') {
          streamUsage = event.usage;
        } else if (event.type === 'done') {
          if (mergeThinking && thinkingTagOpened) {
            thinkingTagOpened = false;
            writeSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: responseModel,
              choices: [{ index: 0, delta: { content: '\n</think>\n' }, finish_reason: null }],
            });
          }

          streamDoneReceived = true;

          // 刷新剩余的内容缓冲
          if (contentFlushBuffer) {
            writeSSE(res, { ...writeOpts, choices: [{ index: 0, delta: { content: contentFlushBuffer }, finish_reason: null }] });
            streamedContent = true;
            contentFlushBuffer = '';
          }

          const extracted = extractAssistantResponse(rawContentBuffer);
          let hasToolCalls = extracted.toolCalls?.length;

          // 容错：extractAssistantResponse 未解析出工具但内容看起来像畸形工具输出时，
          // 尝试使用 parseToolCallsFromText 兜底（处理 [Assistant tool calls]: 等复读格式）
          if (!hasToolCalls && looksLikeMalformedToolOutput(rawContentBuffer) && toolCallingEnabled) {
            console.warn(`[DeepSeek OpenAI stream] Malformed tool output detected, falling back to parseToolCallsFromText`);
            const fallbackParsed = parseToolCallsFromText(rawContentBuffer);
            if (fallbackParsed?.toolCalls?.length) {
              const validated = validateToolCallsPipeline(fallbackParsed.toolCalls, toolChoice, tools);
              if (validated.toolCalls?.length) {
                hasToolCalls = true;
                extracted.toolCalls = validated.toolCalls;
              }
            }
          }

          if (hasToolCalls) {
            streamToolCallsIncremental(res, writeOpts, extracted.toolCalls);
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            });
          } else {
            if (extracted.content && !streamedContent) {
              writeSSE(res, { ...writeOpts, choices: [{ index: 0, delta: { content: extracted.content }, finish_reason: null }] });
              streamedContent = true;
            }
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
          }
          break; // Exit SSE loop — done event is the final signal
        }
      }

      // Drainage: when the upstream stream closes without a proper FINISHED/done
      // event (e.g. DeepSeek v4-pro 'expert' model, connection timeout, or
      // unexpected close), flush the contentBuffer so tool calls and partial
      // responses are not silently lost.
      if (!streamDoneReceived && rawContentBuffer) {
        const extracted = extractAssistantResponse(rawContentBuffer);
        const hasToolCalls = extracted.toolCalls?.length;

        if (hasToolCalls) {
          if (extracted.content && !streamedContent) {
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: { content: extracted.content }, finish_reason: null }],
            });
            streamedContent = true;
          }
          streamToolCallsIncremental(res, writeOpts, extracted.toolCalls);
          writeSSE(res, {
            ...writeOpts,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          });
        } else {
          if (extracted.content && !streamedContent) {
            writeSSE(res, {
              ...writeOpts,
              choices: [{ index: 0, delta: { content: extracted.content }, finish_reason: null }],
            });
            streamedContent = true;
          }
          writeSSE(res, {
            ...writeOpts,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
        }
      }

      writeOpenAISSEDone(res);
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
      recordTTFB(responseModel, totalDuration);
      if (usage > 0 && totalDuration > 0) {
        recordTokenSpeed(responseModel, usage, totalDuration);
      }

      // 使用 extractAssistantResponse 解析 JSON 格式输出
      const extracted = extractAssistantResponse(fullContent);
      let toolCalls = extracted.toolCalls;
      let responseContent = extracted.content;

      // 容错：extractAssistantResponse 未解析出工具但内容看起来像畸形工具输出时，
      // 尝试使用 parseToolCallsFromText 兜底
      if (!toolCalls?.length && looksLikeMalformedToolOutput(fullContent) && toolCallingEnabled) {
        console.warn(`[DeepSeek OpenAI response] Malformed tool output detected, falling back to parseToolCallsFromText`);
        const fallbackParsed = parseToolCallsFromText(fullContent);
        if (fallbackParsed?.toolCalls?.length) {
          const validated = validateToolCallsPipeline(fallbackParsed.toolCalls, toolChoice, tools);
          if (validated.toolCalls?.length) {
            toolCalls = validated.toolCalls;
            responseContent = fallbackParsed.content || null;
          }
        }
      }

      const message = toolCalls?.length
        ? {
            role: 'assistant',
            content: responseContent || null,
            tool_calls: toolCalls,
            ...((!mergeThinking && fullThinking) ? { reasoning_content: fullThinking } : {}),
          }
        : {
            role: 'assistant',
            content: mergeThinking && fullThinking
              ? `<think>\n${fullThinking}\n</think>\n${responseContent ?? fullContent}`
              : (responseContent ?? fullContent),
            ...((!mergeThinking && fullThinking) ? { reasoning_content: fullThinking } : {}),
          };

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
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
    const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
    const fullPrompt = buildPrompt(openaiReq.messages, tools, toolChoice);
    const thinkingEnabled = openaiReq.thinking_enabled ?? true;
    const searchEnabled = true;

    const requestId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let contextPlan = selectContextExecutionPlan({
      requestedModel: model,
      requestedModelType: modelType,
      promptForBudget: fullPrompt,
    });

    // 4. 调用自建系统（使用 Token 池 + chat.deepseek.com）
    const completionResult = await completionWithContextFallback(contextPlan, (activePlan) => ({
      modelType: activePlan.modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds: [],
      preferVision: activePlan.effectiveModel === DEEPSEEK_FLASH_MODEL,
    }));
    const result = completionResult.result;
    contextPlan = completionResult.plan;
    setContextPlanHeaders(res, contextPlan);

    const { body: streamBody, slot } = result;
    const responseModel = contextPlan.effectiveModel || model;

    // 监听客户端断开
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      try { streamBody.cancel(); } catch {}
    };
    req.on('close', onClose);

    try {
      if (stream) {
        // 立即发送 SSE headers + message_start，实现实时流式输出
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        writeClaudeSSE(res, {
          type: 'message_start',
          message: {
            id: requestId,
            type: 'message',
            role: 'assistant',
            model: responseModel,
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        // 使用增量 JSON 提取器实时流式输出 assistant_response 文本
        const claudeExtractor = createJsonContentExtractor();
        let rawContentBuffer = '';
        let thinkingBlockOpened = false;
        let textBlockOpened = false;
        let streamedTextContent = false;
        let blockIdx = 0;
        let hasStreamError = null;
        let streamFinished = false;
        // 缓冲提取的文本，达到阈值再写入 text_delta，避免逐字符事件
        let claudeFlushBuffer = '';
        const CLAUDE_FLUSH_THRESHOLD = 20;

        for await (const event of parseSSEStream(streamBody)) {
          if (clientGone) return;

          if (event.type === 'thinking' && event.content) {
            // 关闭已打开的 text block
            if (textBlockOpened && claudeFlushBuffer) {
              writeClaudeSSE(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: claudeFlushBuffer } });
              writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
              textBlockOpened = false;
              claudeFlushBuffer = '';
              blockIdx++;
            }
            if (!thinkingBlockOpened) {
              writeClaudeSSE(res, {
                type: 'content_block_start',
                index: blockIdx,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              });
              thinkingBlockOpened = true;
            }
            writeClaudeSSE(res, {
              type: 'content_block_delta',
              index: blockIdx,
              delta: { type: 'thinking_delta', thinking: event.content },
            });
          } else if (event.type === 'content' && event.content) {
            rawContentBuffer += event.content;
            if (!toolCallingEnabled) {
              if (thinkingBlockOpened) {
                writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
                blockIdx++;
                thinkingBlockOpened = false;
              }
              if (!textBlockOpened) {
                writeClaudeSSE(res, { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
                textBlockOpened = true;
              }
              writeClaudeSSE(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: event.content } });
              streamedTextContent = true;
              continue;
            }

            const delta = claudeExtractor.process(event.content);
            if (delta) {
              claudeFlushBuffer += delta;
              // 关闭 thinking block
              if (thinkingBlockOpened) {
                writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
                blockIdx++;
                thinkingBlockOpened = false;
              }
              // 累积到阈值或值结束时批量输出
              if (claudeFlushBuffer.length >= CLAUDE_FLUSH_THRESHOLD || claudeExtractor.isDone()) {
                if (!textBlockOpened) {
                  writeClaudeSSE(res, { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
                  textBlockOpened = true;
                }
                writeClaudeSSE(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: claudeFlushBuffer } });
                streamedTextContent = true;
                claudeFlushBuffer = '';
              }
            }
          } else if (event.type === 'done') {
            streamFinished = true;
            break;
          } else if (event.type === 'error') {
            hasStreamError = event.message || 'DeepSeek stream error';
            break;
          }
        }

        if (clientGone) return;
        if (hasStreamError) throw new Error(hasStreamError);

        // 关闭 thinking block（如果仍打开）
        if (thinkingBlockOpened) {
          writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
          thinkingBlockOpened = false;
        }

        // 刷新并关闭 text block
        if (textBlockOpened) {
          if (claudeFlushBuffer) {
            writeClaudeSSE(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: claudeFlushBuffer } });
            claudeFlushBuffer = '';
          }
          writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
          textBlockOpened = false;
        }

        // 解析完整 JSON 获取 tool_calls
        const extracted = extractAssistantResponse(rawContentBuffer);
        const hasValidToolCalls = extracted.toolCalls?.length;

        if (extracted.content && !streamedTextContent) {
          writeClaudeSSE(res, { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } });
          writeClaudeSSE(res, { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: extracted.content } });
          writeClaudeSSE(res, { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
          streamedTextContent = true;
        }

        if (hasValidToolCalls) {
          // 输出 tool_use blocks
          for (const tc of extracted.toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

            writeClaudeSSE(res, {
              type: 'content_block_start',
              index: blockIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id || `toolu_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                name: tc.function.name,
                input: {},
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

        // 使用 extractAssistantResponse 解析 JSON 格式输出
        const extracted = extractAssistantResponse(fullText);
        const hasValidToolCalls = extracted.toolCalls?.length;

        let claudeResp;
        if (hasValidToolCalls) {
          const contentBlocks = [];

          if (fullThinking) {
            contentBlocks.push({ type: 'thinking', thinking: fullThinking });
          }

          if (extracted.content) {
            contentBlocks.push({ type: 'text', text: extracted.content });
          }

          for (const tc of extracted.toolCalls) {
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
            model: responseModel,
            content: contentBlocks,
            stop_reason: 'tool_use',
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        } else {
          const contentBlocks = [];
          if (fullThinking) {
            contentBlocks.push({ type: 'thinking', thinking: fullThinking });
          }
          contentBlocks.push({ type: 'text', text: extracted.content ?? fullText });
          claudeResp = {
            id: requestId,
            type: 'message',
            role: 'assistant',
            model: responseModel,
            content: contentBlocks,
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
