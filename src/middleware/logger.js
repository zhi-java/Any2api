// Request logger — writes request metadata to disk (JSONL, one file per day).
//
// 设计约束（低配服务器）：**任何路径都不得把整个日志文件读进内存**。
// 历史上存在 readChatLogs/readHistoricalLogs 会把单日 60MB+ 的 jsonl 全量
// readFileSync 再逐行 JSON.parse，一次调用即产生数十 MB 内存尖峰。这些
// 功能已移除；需要回溯历史时用 `tail`/`grep` 直接读文件即可。
//
// Usage: import { requestLogger, getLogStats, readRecentLogs } from './logger.js';
//        app.use(requestLogger('omni'));

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve, relative } from 'path';
import { recordRequest, recordUsageRecord, takeUsage } from './metrics.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { getConfig, getDataDir } from '../services/config-store.js';

// 内存中保留的近期日志条数。
//
// 原值 1000：日志页最多只展示 200 条，多出的 800 条纯属内存占用。
// 低配服务器上取 300（覆盖页面最大展示量 + 余量）。
// 可用 LOG_MEMORY_LIMIT 覆盖。
function memoryLimit() {
  const parsed = parseInt(process.env.LOG_MEMORY_LIMIT || '300', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

const recentLogs = [];
let totalLogged = 0;
let successLogged = 0;
let errorLogged = 0;
let serviceName = 'default';

function currentLogDir() {
  return getConfig().runtime.logDir || resolve(getDataDir(), 'logs');
}

// Strict YYYY-MM-DD only. Anything else (e.g. "../../etc/passwd") falls back to
// today, closing the path-traversal vector that flowed from req.query.date.
function sanitizeDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date().toISOString().slice(0, 10);
}

// Defence in depth: reject any resolved path that escapes logDir (e.g. via a
// symlink or a future change to the join logic).
function assertWithinLogDir(targetPath) {
  const root = resolve(currentLogDir());
  const rel = relative(root, resolve(targetPath));
  if (rel.startsWith('..') || resolve(targetPath) === root) {
    throw new Error('path escapes log directory');
  }
}

function channelForModel(model) {
  if (Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, model)) return 'deepseek';
  return 'unknown';
}

function isExternalApiPath(path) {
  return path === '/v1/chat/completions'
    || path === '/v1/messages'
    || path === '/v1/responses'
    || path === '/v1/models'
    || path === '/chat/completions'
    || path === '/messages'
    || path === '/responses'
    || path === '/models';
}

function protocolForPath(path) {
  if (path === '/v1/chat/completions' || path === '/chat/completions') return 'chat_completions';
  if (path === '/v1/messages' || path === '/messages') return 'claude_messages';
  if (path === '/v1/responses' || path === '/responses') return 'responses';
  if (path === '/v1/models' || path === '/models') return 'models';
  return 'other';
}

function channelForEntry(entry) {
  const fromModel = channelForModel(entry.model);
  if (fromModel !== 'unknown') return fromModel;
  return isExternalApiPath(entry.path) ? 'api' : 'unknown';
}

function getLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(currentLogDir(), serviceName);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${safeDate}.jsonl`);
  assertWithinLogDir(p);
  return p;
}

function writeLog(entry) {
  try {
    appendFileSync(getLogPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Log write failed:', e.message);
  }
}

const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
]);

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function maxDebugChars() {
  const parsed = parseInt(process.env.CLIENT_DEBUG_LOG_MAX_CHARS || '200000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200000;
}

/**
 * 单个响应体在内存中的捕获上限（字符数）。
 *
 * 为什么必须有上限：`res.write` 的包装会把**每个流式分片**拼进数组，直到
 * 响应结束才 join。一个长回复（数万 token 的正文 + 思考）能达到数 MB，
 * 且与并发数相乘——低配服务器上这是最直接的内存放大器。
 *
 * 超限后我们**停止累积正文**，只保留已捕获的前缀与总字节数；日志记录
 * 降级为"元数据 + 截断正文"，而不是把整段回复留在内存里喂给日志。
 * 日志是观测手段，不该成为内存瓶颈。
 *
 * 可用 LOG_RESPONSE_CAPTURE_MAX_CHARS 覆盖（0 = 不捕获响应体，最省内存）。
 */
function maxResponseCaptureChars() {
  const parsed = parseInt(process.env.LOG_RESPONSE_CAPTURE_MAX_CHARS || '262144', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 262144; // 默认 256KB
  return parsed;
}

function truncateDebugValue(value, maxChars = maxDebugChars()) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers || {})) {
    redacted[name] = REDACTED_HEADER_NAMES.has(String(name).toLowerCase()) ? '[REDACTED]' : value;
  }
  return redacted;
}

function getClientDebugLogPath(date) {
  const safeDate = sanitizeDate(date);
  const root = getConfig().server.clientDebugLogDir || currentLogDir();
  const dir = join(root, serviceName, 'client-debug');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${safeDate}.jsonl`);
  const rel = relative(resolve(root), resolve(p));
  if (rel.startsWith('..') || resolve(p) === resolve(root)) {
    throw new Error('path escapes debug log directory');
  }
  return p;
}

/**
 * 单日调试日志的大小上限（字节）。超出即停止写入当天文件并告警一次。
 *
 * 调试日志记录完整请求/响应正文，是磁盘增长最快的部分——实测默认配置
 * 下单日可达 37MB。在低配服务器上必须有硬上限，否则磁盘会被慢慢写满。
 * 可用 CLIENT_DEBUG_LOG_MAX_BYTES 覆盖（0 = 不限制，不建议）。
 */
function maxDebugLogBytes() {
  const parsed = parseInt(process.env.CLIENT_DEBUG_LOG_MAX_BYTES || String(20 * 1024 * 1024), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20 * 1024 * 1024;
}

// 每份调试日志文件只告警一次，避免刷屏。
const debugLogWarned = new Set();

function writeClientDebugLog(entry) {
  if (!envFlag('CLIENT_DEBUG_LOG')) return;
  try {
    const path = getClientDebugLogPath();
    const limit = maxDebugLogBytes();
    if (limit > 0) {
      let size = 0;
      try { size = statSync(path).size; } catch { /* 文件尚不存在 */ }
      if (size >= limit) {
        if (!debugLogWarned.has(path)) {
          debugLogWarned.add(path);
          console.warn(
            `[logger] 客户端调试日志已达上限 ${(limit / 1024 / 1024).toFixed(0)}MB，暂停写入：${path}`
            + '（排障完成后建议在后台关闭「客户端调试日志」）',
          );
        }
        return;
      }
    }
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Client debug log write failed:', e.message);
  }
}

/**
 * 清理过期的调试日志（按天命名的 .jsonl）。
 * 默认保留 7 天（可用 CLIENT_DEBUG_LOG_KEEP_DAYS 覆盖），
 * 避免长期开启调试日志把磁盘写满。
 */
export function pruneDebugLogs() {
  const parsed = parseInt(process.env.CLIENT_DEBUG_LOG_KEEP_DAYS || '7', 10);
  const keepDays = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  const root = getConfig().server.clientDebugLogDir || currentLogDir();
  const dir = join(root, serviceName, 'client-debug');
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const date = name.replace('.jsonl', '');
      const ts = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      try { unlinkSync(join(dir, name)); } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 目录不存在等：无需清理 */ }
}

function requestBodySnapshot(req) {
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
  if (raw) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return req.body ?? null;
}

function sseStats(rawBody) {
  const stats = { dataLines: 0, eventLines: 0, events: {}, openaiContentDeltas: 0, claudeTextDeltas: 0, claudeThinkingDeltas: 0 };
  for (const line of String(rawBody || '').split('\n')) {
    if (line.startsWith('event: ')) {
      stats.eventLines++;
      const eventName = line.slice(7).trim();
      stats.events[eventName] = (stats.events[eventName] || 0) + 1;
    } else if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      stats.dataLines++;
      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') stats.openaiContentDeltas++;
        if (data.type === 'content_block_delta') {
          if (typeof data.delta?.text === 'string') stats.claudeTextDeltas++;
          if (typeof data.delta?.thinking === 'string') stats.claudeThinkingDeltas++;
        }
      } catch {}
    }
  }
  return stats;
}

export function requestLogger(name) {
  serviceName = name || serviceName;

  return (req, res, next) => {
    const start = Date.now();
    const requestPath = (req.originalUrl || req.path || '').split('?')[0];
    const protocol = protocolForPath(requestPath);
    const isChat = requestPath === '/v1/chat/completions' || requestPath === '/v1/messages' || requestPath === '/v1/responses';
    const model = req.body?.model || '-';
    const initialStream = req.body?.stream === true;

    // 捕获响应体（有上限）。
    //
    // 旧实现无脑 push 每个分片，长回复会把整段内容留在内存直到 finish。
    // 这里改为：累积到 captureLimit 后停止拼接，只继续统计字节数。
    // 注意必须始终把 chunk 原样转发给 originalWrite —— 捕获逻辑绝不能
    // 影响实际响应。
    const captureLimit = maxResponseCaptureChars();
    let captured = '';
    let capturedBytes = 0;
    let captureTruncated = false;

    const captureChunk = (chunk) => {
      if (captureLimit === 0) {
        capturedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        return;
      }
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      capturedBytes += Buffer.byteLength(text);
      if (captured.length >= captureLimit) {
        captureTruncated = true;
        return;
      }
      captured += text;
      if (captured.length > captureLimit) {
        captured = captured.slice(0, captureLimit);
        captureTruncated = true;
      }
    };

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk, ...args) {
      captureChunk(chunk);
      return originalWrite(chunk, ...args);
    };

    res.end = function (chunk, ...args) {
      if (chunk) captureChunk(chunk);
      return originalEnd(chunk, ...args);
    };

    res.on('finish', () => {
      const duration = Date.now() - start;
      // 已捕获的响应前缀（可能因超出 captureLimit 被截断，见 captureTruncated）。
      // 截断只影响日志内容的完整性，不影响流式判定与客户端响应本身。
      const rawBody = captured;
      const responseWasStream = initialStream
        || req.body?.stream === true
        || /(?:^|\n)(?:event|data): /m.test(rawBody);
      let assistantContent = '';
      let reasoningContent = '';
      let finishReason = null;
      let usage = null;
      let requestId = null;
      let responseModel = null;
      const entry = {
        time: new Date().toISOString(),
        method: req.method,
        path: requestPath,
        protocol,
        model,
        channel: channelForModel(model),
        status: res.statusCode,
        duration,
      };

      // Add prompt injection flag for chat endpoints
      if (isChat) {
        entry.promptInjectionEnabled = req.omni?.promptInjectionEnabled;
      }

      console.log(`[${entry.time}] ${entry.method} ${entry.path} model=${entry.model} ${entry.status} ${entry.duration}ms${entry.error?.message ? ' error=' + entry.error.message.slice(0,120) : ''}`);

      // Record to metrics collector。
      // 若 runner 已上报本次用量的 token 数，一并写入以便计算 tok/s
      // （口径：输出 tokens ÷ 总耗时，与 OpenAI 官方一致）。
      // 用 runner 上报的 durationMs（服务端视角的完整耗时）而非此处
      // 的 duration，避免两者口径不一致；队列按请求先后 FIFO 配对。
      const record = recordRequest(model, duration, res.statusCode);
      // 用量由 runner 挂在 res 上（严格 1:1，不受并发影响），此处消费一次，
      // 并直接写入本次刚创建的记录，不做任何"最近记录"式的模糊匹配。
      const reportedUsage = takeUsage(res);
      if (reportedUsage) recordUsageRecord(record, reportedUsage);

      // Add error details for failed requests
      if (res.statusCode >= 400) {
        try {
          const errJson = JSON.parse(rawBody.split('\n').find(l => l.startsWith('data: '))?.slice(6) || rawBody);
          entry.error = errJson.error || errJson;
        } catch {
          entry.error = rawBody.slice(0, 500);
        }
      }

      // Write request log (metadata only)
      writeLog(entry);
      totalLogged++;
      if (res.statusCode >= 400) errorLogged++;
      else successLogged++;

      // Keep recent in memory（有上限的环形缓冲）
      const limit = memoryLimit();
      if (recentLogs.length >= limit) recentLogs.shift();
      recentLogs.push(entry);

      // 解析响应流，提取 assistant 正文与 usage —— 仅供调试日志使用。
      //
      // 这里**不再**写"完整对话"日志（writeChatLog 已移除）：旧实现会把
      // 请求 messages 与完整响应正文再落一份盘，单日可累积 60MB+，是磁盘与
      // 内存的双重负担。请求元数据仍由 writeLog 记录，响应正文仅记录在
      // 调试日志中（且默认关闭、受大小限制保护）。
      if (isChat && res.statusCode === 200 && responseWasStream) {
        const lines = rawBody.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          if (line.startsWith('event: ')) {
            const dataLine = lines[li + 1];
            if (dataLine?.startsWith('data: ')) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                if (protocol === 'claude_messages') {
                  if (data.type === 'content_block_delta') {
                    if (data.delta?.text) assistantContent += data.delta.text;
                    if (data.delta?.thinking) reasoningContent += data.delta.thinking;
                  }
                  if (data.type === 'message_start') {
                    requestId = data.message?.id;
                    responseModel = data.message?.model;
                    usage = data.message?.usage;
                  }
                  if (data.type === 'message_delta') {
                    finishReason = data.delta?.stop_reason;
                    usage = data.usage || usage;
                  }
                }
              } catch {}
            }
            continue;
          }
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (protocol === 'responses') {
                if (data.type === 'response.output_text.delta' && data.delta) assistantContent += data.delta;
                if (data.type === 'response.created') { requestId = data.response?.id; responseModel = data.response?.model; }
                if (data.type === 'response.completed') { finishReason = 'completed'; usage = data.response?.usage; }
                if (data.type === 'response.failed') { finishReason = 'failed'; }
              } else {
                const delta = data.choices?.[0]?.delta;
                if (delta?.content) assistantContent += delta.content;
                if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
                if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;
                if (data.id) requestId = data.id;
                if (data.usage) usage = data.usage;
              }
            } catch {}
          }
        }
      } else if (isChat && res.statusCode === 200) {
        try {
          const json = JSON.parse(rawBody);
          if (protocol === 'responses') {
            assistantContent = json.output_text || '';
            requestId = json.id;
            finishReason = json.status;
            usage = json.usage;
          } else if (protocol === 'claude_messages') {
            assistantContent = json.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
            reasoningContent = json.content?.filter(c => c.type === 'thinking').map(c => c.thinking).join('') || '';
            requestId = json.id;
            finishReason = json.stop_reason;
            usage = json.usage;
            responseModel = json.model;
          } else {
            const msg = json.choices?.[0]?.message;
            assistantContent = msg?.content || '';
            reasoningContent = msg?.reasoning_content || '';
            requestId = json.id;
            finishReason = json.choices?.[0]?.finish_reason;
            usage = json.usage;
          }
        } catch {}
      }

      writeClientDebugLog({
        time: entry.time,
        duration,
        protocol,
        request: {
          method: req.method,
          path: requestPath,
          originalUrl: req.originalUrl,
          headers: redactHeaders(req.headers),
          body: truncateDebugValue(requestBodySnapshot(req)),
          effectiveBody: truncateDebugValue(req.body ?? null),
        },
        response: {
          status: res.statusCode,
          headers: redactHeaders(typeof res.getHeaders === 'function' ? res.getHeaders() : {}),
          isStream: responseWasStream,
          sse: responseWasStream ? sseStats(rawBody) : undefined,
          rawBody: truncateDebugValue(rawBody),
          assistantText: assistantContent,
          reasoningText: reasoningContent,
          finishReason,
          usage,
          requestId,
          model: responseModel || model,
        },
      });
    });

    next();
  };
}

export function getRecentLogs(count = 50) {
  return recentLogs.slice(-count);
}

export function getLogStats() {
  const now = Date.now();
  const last5min = recentLogs.filter(e => now - new Date(e.time).getTime() < 300000);
  const errors = last5min.filter(e => e.status >= 400);
  const avgDuration = last5min.length
    ? Math.round(last5min.reduce((s, e) => s + e.duration, 0) / last5min.length)
    : 0;
  return {
    totalRequests: totalLogged,
    successCount: successLogged,
    errorCount: errorLogged,
    totalLogged,
    memoryBuffer: recentLogs.length,
    last5min: last5min.length,
    errors5min: errors.length,
    avgDuration5min: avgDuration,
  };
}

export function readRecentLogs(count = 50, filters = {}) {
  return filterLogs(recentLogs, filters).slice(-count).reverse();
}

export function filterLogs(logs, filters = {}) {
  const channel = String(filters.channel || 'all').toLowerCase();
  const model = String(filters.model || 'all').toLowerCase();
  const status = String(filters.status || 'all').toLowerCase();
  const search = String(filters.search || '').trim().toLowerCase();
  const apiOnly = filters.apiOnly === true || filters.apiOnly === 'true';
  const excludeUnknown = filters.excludeUnknown === true || filters.excludeUnknown === 'true';

  return logs.filter(entry => {
    const entryChannel = String(entry.channel && entry.channel !== 'unknown' ? entry.channel : channelForEntry(entry)).toLowerCase();
    const entryModel = String(entry.model || '').toLowerCase();
    if (apiOnly && !isExternalApiPath(entry.path)) return false;
    if (excludeUnknown && entryChannel === 'unknown') return false;
    if (channel !== 'all' && entryChannel !== channel) return false;
    if (model !== 'all' && entryModel !== model) return false;
    if (status === 'error' && entry.status < 400) return false;
    if (status === 'success' && entry.status >= 400) return false;
    if (/^\d+$/.test(status) && String(entry.status) !== status) return false;
    if (search) {
      const haystack = `${entry.time} ${entry.method} ${entry.path} ${entry.model} ${entryChannel} ${entry.status} ${entry.duration}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

// 历史日志读取（readHistoricalLogs / readChatLogs / listLogDates）已移除。
//
// 它们用 readFileSync 把整天的 jsonl（实测单日 26MB~68MB）一次性读入内存，
// 再 split + 逐行 JSON.parse —— 在低配服务器上单个请求即可造成数十 MB 的
// 内存尖峰，且这些数据本就在磁盘上。需要回溯历史时直接用文件工具读取：
//   tail -n 200 <logDir>/omni/2026-09-15.jsonl
//   grep '"status":50' <logDir>/omni/2026-09-15.jsonl | tail -n 50
