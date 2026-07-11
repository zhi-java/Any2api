// Request logger — writes all requests + full conversations to disk
// Usage: import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, listLogDates } from './logger.js';
//        app.use(requestLogger('omni'));

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { recordRequest } from './metrics.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { GLM_MODEL_MAP } from '../channels/glm/models.js';
import { QWEN_MODEL_MAP } from '../channels/qwen/models.js';
import { KIMI_MODEL_MAP } from '../channels/kimi/models.js';
import { getConfig, getDataDir } from '../services/config-store.js';

const MEMORY_LIMIT = 1000;
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
  if (Object.prototype.hasOwnProperty.call(GLM_MODEL_MAP, model)) return 'glm';
  if (Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, model)) return 'qwen';
  if (Object.prototype.hasOwnProperty.call(KIMI_MODEL_MAP, model)) return 'kimi';
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

function getChatLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(currentLogDir(), serviceName, 'chats');
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

function writeChatLog(entry) {
  try {
    appendFileSync(getChatLogPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Chat log write failed:', e.message);
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

function writeClientDebugLog(entry) {
  if (!envFlag('CLIENT_DEBUG_LOG')) return;
  try {
    appendFileSync(getClientDebugLogPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Client debug log write failed:', e.message);
  }
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
    const messages = req.body?.messages ?? req.body?.input ?? null;
    const model = req.body?.model || '-';
    const initialStream = req.body?.stream === true;

    // Capture response body
    const chunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk, ...args) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...args);
    };

    res.end = function (chunk, ...args) {
      if (chunk) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalEnd(chunk, ...args);
    };

    res.on('finish', () => {
      const duration = Date.now() - start;
      const rawBody = chunks.join('');
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

      // Record to metrics collector
      recordRequest(model, duration, res.statusCode);

      // Add error details for failed requests
      if (res.statusCode >= 400) {
        const rawBody = chunks.join('');
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

      // Keep recent in memory
      if (recentLogs.length >= MEMORY_LIMIT) recentLogs.shift();
      recentLogs.push(entry);

      // Write full chat log for chat endpoints
      if (isChat && res.statusCode === 200) {
        if (responseWasStream) {
          const lines = rawBody.split('\n');
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            if (line.startsWith('event: ')) {
              const eventName = line.slice(7).trim();
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
        } else {
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

        writeChatLog({
          time: entry.time,
          protocol,
          model: responseModel || model,
          stream: responseWasStream,
          duration,
          requestId,
          finishReason,
          messages,
          response: assistantContent,
          reasoning: reasoningContent || undefined,
          usage,
        });
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

export function readHistoricalLogs(date, count = 100) {
  try {
    const data = readFileSync(getLogPath(date), 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).slice(-count);
  } catch {
    return [];
  }
}

export function readChatLogs(date, count = 50) {
  try {
    const data = readFileSync(getChatLogPath(date), 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).slice(-count);
  } catch {
    return [];
  }
}

export function listLogDates() {
  try {
    const dir = join(currentLogDir(), serviceName);
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  } catch {
    return [];
  }
}
