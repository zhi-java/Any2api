// Request logger — writes all requests + full conversations to disk
// Usage: import { requestLogger, getRecentLogs, getLogStats, readHistoricalLogs, listLogDates } from './logger.js';
//        app.use(requestLogger('zhi2api'));

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { recordRequest } from './metrics.js';
import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { GLM_MODEL_MAP } from '../channels/glm/models.js';
import { QWEN_MODEL_MAP } from '../channels/qwen/models.js';
import { KIMI_MODEL_MAP } from '../channels/kimi/models.js';

const MEMORY_LIMIT = 1000;
const recentLogs = [];
let totalLogged = 0;
let successLogged = 0;
let errorLogged = 0;
let logDir = process.env.LOG_DIR || 'logs';
let serviceName = 'default';

// Strict YYYY-MM-DD only. Anything else (e.g. "../../etc/passwd") falls back to
// today, closing the path-traversal vector that flowed from req.query.date.
function sanitizeDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date().toISOString().slice(0, 10);
}

// Defence in depth: reject any resolved path that escapes logDir (e.g. via a
// symlink or a future change to the join logic).
function assertWithinLogDir(targetPath) {
  const root = resolve(logDir);
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
    || path === '/v1/models'
    || path === '/chat/completions'
    || path === '/messages'
    || path === '/models';
}

function channelForEntry(entry) {
  const fromModel = channelForModel(entry.model);
  if (fromModel !== 'unknown') return fromModel;
  return isExternalApiPath(entry.path) ? 'api' : 'unknown';
}

function getLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(logDir, serviceName);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${safeDate}.jsonl`);
  assertWithinLogDir(p);
  return p;
}

function getChatLogPath(date) {
  const safeDate = sanitizeDate(date);
  const dir = join(logDir, serviceName, 'chats');
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

export function requestLogger(name) {
  serviceName = name || serviceName;
  if (process.env.LOG_DIR) logDir = process.env.LOG_DIR;

  return (req, res, next) => {
    const start = Date.now();
    const requestPath = (req.originalUrl || req.path || '').split('?')[0];
    const isChat = requestPath === '/v1/chat/completions' || requestPath === '/v1/messages' || requestPath === '/api/v0/chat/completion';
    const messages = req.body?.messages || null;
    const model = req.body?.model || '-';
    const stream = req.body?.stream || false;

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
      const entry = {
        time: new Date().toISOString(),
        method: req.method,
        path: requestPath,
        model,
        channel: channelForModel(model),
        status: res.statusCode,
        duration,
      };

      console.log(`[${entry.time}] ${entry.method} ${entry.path} model=${entry.model} ${entry.status} ${entry.duration}ms`);

      // Record to metrics collector
      recordRequest(model, duration, res.statusCode);

      // Write request log (metadata only)
      writeLog(entry);
      totalLogged++;
      if (res.statusCode >= 400) errorLogged++;
      else successLogged++;

      // Keep recent in memory
      if (recentLogs.length >= MEMORY_LIMIT) recentLogs.shift();
      recentLogs.push(entry);

      // Write full chat log for chat endpoints
      if (isChat && messages && res.statusCode === 200) {
        let assistantContent = '';
        let reasoningContent = '';
        if (stream) {
          // Parse SSE stream to extract both content and reasoning_content deltas
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta;
                  if (delta?.content) assistantContent += delta.content;
                  if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
                } catch {}
              }
            }
          }
        } else {
          try {
            const body = chunks.join('');
            const json = JSON.parse(body);
            const msg = json.choices?.[0]?.message;
            assistantContent = msg?.content || '';
            reasoningContent = msg?.reasoning_content || '';
          } catch {}
        }

        writeChatLog({
          time: entry.time,
          model,
          stream,
          duration,
          messages,
          response: assistantContent,
          reasoning: reasoningContent || undefined,
        });
      }
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
    const dir = join(logDir, serviceName);
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  } catch {
    return [];
  }
}
