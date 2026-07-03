import { setRequestToken, reportTokenError, reportTokenSuccess, markTokenDead, getPoolInfo } from '../services/auth.js';
import { solvePowChallengeWithToken } from './pow.js';
import { getSession, invalidateTokenSessions } from '../services/session.js';
import { invalidateByTokenPrefix } from '../services/conversation.js';
import { streamHeaders, proxiedFetch } from './headers.js';
import { enqueueRequest, dispatchQueued } from '../services/queue.js';

const BASE_URL = 'https://chat.deepseek.com';

function deepSeekErrorMessage(json, fallback = 'DeepSeek error') {
  const biz = json?.data;
  const code = json?.code ?? biz?.biz_code;
  const msg = json?.msg || biz?.biz_msg || fallback;
  return { code, message: msg };
}

export function isInvalidChatSessionError(code, message) {
  return String(code) === '0' && /invalid chat session id/i.test(String(message || ''));
}

async function invalidateTokenRuntimeState(token) {
  const tokenPrefix = token.slice(0, 12);
  invalidateTokenSessions(tokenPrefix);
  invalidateByTokenPrefix(tokenPrefix);
}

async function markTokenUnavailable(token) {
  // Muted tokens are unusable for completions until the mute expires, so mark dead immediately.
  markTokenDead(token);
  await invalidateTokenRuntimeState(token);
}

function isDeepSeekJsonError(json) {
  return json?.code !== undefined || json?.data?.biz_code !== undefined || json?.data?.biz_msg;
}

async function throwDeepSeekErrorFromJson(json, slot) {
  const { code, message } = deepSeekErrorMessage(json);

  if (!isDeepSeekJsonError(json)) return;

  if (code === 40003) {
    reportTokenError(slot.token);
    throw new Error('Token invalid (40003)');
  }
  if (code === 40004) {
    reportTokenError(slot.token);
    const entry = getPoolInfo().find(t => slot.token.startsWith(t.token.replace('...', '')));
    console.error(`Account BANNED during completion: ${entry?.email || slot.token.slice(0, 12)}...`);
    throw new Error('Account banned (40004)');
  }
  if (code === 40301) {
    await invalidateTokenRuntimeState(slot.token);
    throw new Error('Session rate limited (40301) — sessions rotated');
  }
  if (isInvalidChatSessionError(code, message)) {
    await invalidateTokenRuntimeState(slot.token);
    const err = new Error('DeepSeek invalid chat session id — session cache invalidated');
    err.retryableInvalidSession = true;
    throw err;
  }
  if (code === 429) {
    throw new Error('Rate limited (429)');
  }
  if (code === 5 || json?.data?.biz_code === 5) {
    await markTokenUnavailable(slot.token);
    const until = json?.data?.biz_data?.mute_until;
    throw new Error(`DeepSeek user muted (biz_code=5)${until ? ` until ${until}` : ''}: ${message}`);
  }

  throw new Error(`DeepSeek error${code != null ? ` ${code}` : ''}: ${message}`);
}

// resolveSession(token): optional async hook. When provided (conversation-affinity
// mode), it is called AFTER the token slot is acquired and must return
// { sessionId, parentMessageId, affinity }. When omitted, a session is
// acquired/rotated via getSession and parentMessageId defaults to null (legacy
// behaviour).
// getPrompt(affinity): optional sync hook returning the prompt string to send,
// chosen based on whether affinity engaged. When omitted, the `prompt` arg is
// used as-is. This keeps prompt selection sequenced after session resolution.
export async function completion({ modelType, prompt, thinkingEnabled = false, searchEnabled = false, parentMessageId = null, refFileIds = [], preferVision = false, resolveSession = null, getPrompt = null }) {
  // Step 1: Acquire token slot first — PoW and completion must use the same token
  const slot = await enqueueRequest(preferVision);

  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Step 2: Solve PoW using the same token. Retry attempts resolve a new
        // session after the stale one has been invalidated.
        const { powResponse } = await solvePowChallengeWithToken(slot.token);

        let sessionIdFinal;
        let parentMessageIdFinal = parentMessageId;
        let affinity = false;
        if (resolveSession) {
          // Affinity mode: the caller decides which session + parent to use,
          // bound to the token that was just acquired.
          const resolved = await resolveSession(slot.token);
          sessionIdFinal = resolved.sessionId;
          parentMessageIdFinal = resolved.parentMessageId;
          affinity = !!resolved.affinity;
        } else {
          setRequestToken(slot.token);
          try {
            const session = await getSession(slot.token, modelType);
            sessionIdFinal = session.id;
          } finally {
            setRequestToken(null);
          }
        }

        const promptFinal = getPrompt ? getPrompt(affinity) : prompt;

        const body = {
          chat_session_id: sessionIdFinal,
          parent_message_id: parentMessageIdFinal,
          model_type: modelType,
          prompt: promptFinal,
          ref_file_ids: refFileIds,
          thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled,
          action: null,
          preempt: false,
        };

        const res = await proxiedFetch(`${BASE_URL}/api/v0/chat/completion`, {
          method: 'POST',
          headers: await streamHeaders(slot.token, powResponse),
          body: JSON.stringify(body),
        });

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const text = await res.text();
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(text), slot);
          } catch (err) {
            if (err instanceof SyntaxError) throw new Error(`Completion request returned invalid JSON: ${text}`);
            throw err;
          }
        }

        if (!res.ok) {
          const text = await res.text();
          // Check for specific DeepSeek error codes
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(text), slot);
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              throw new Error(`Completion request failed: ${res.status} ${text}`);
            }
            throw parseErr;
          }
        }

        // DeepSeek sometimes returns HTTP 200 + text/event-stream but the body is a plain JSON error,
        // e.g. {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted"}}.
        // Probe the first chunk so those errors are surfaced instead of being parsed as an empty SSE stream.
        const reader = res.body.getReader();
        const first = await reader.read();
        if (first.done) {
          reader.releaseLock();
          throw new Error('Completion stream ended before any data');
        }

        const firstText = new TextDecoder().decode(first.value, { stream: true }).trim();
        if (firstText.startsWith('{')) {
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(firstText), slot);
          } catch (err) {
            if (!(err instanceof SyntaxError)) {
              try { await reader.cancel(); } catch {}
              try { reader.releaseLock(); } catch {}
              throw err;
            }
          }
        }

        const bodyWithFirstChunk = new ReadableStream({
          start(controller) {
            controller.enqueue(first.value);
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) {
                reader.releaseLock();
                controller.close();
                return;
              }
              controller.enqueue(value);
              return pump();
            }).catch(err => {
              try { reader.releaseLock(); } catch {}
              controller.error(err);
            });
            return pump();
          },
          cancel(reason) {
            return reader.cancel(reason).finally(() => {
              try { reader.releaseLock(); } catch {}
            });
          },
        });

        reportTokenSuccess(slot.token);
        return { body: bodyWithFirstChunk, slot };
      } catch (err) {
        setRequestToken(null);
        lastErr = err;
        if (err?.retryableInvalidSession && attempt === 0) {
          console.warn(`[DeepSeek] Invalid chat session for ${slot.token.slice(0, 12)}..., refreshing session and retrying once`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    setRequestToken(null);
    slot.release();
    dispatchQueued();
    throw err;
  }
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageIds = {};
  let currentFragmentType = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const leftover = buffer.trim();
        if (leftover.startsWith('{')) {
          try {
            const parsed = JSON.parse(leftover);
            const { code, message } = deepSeekErrorMessage(parsed);
            yield { type: 'error', code, message };
          } catch {}
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          if (line.slice(6).trim() === 'close') return;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          // Check for error codes mid-stream
          if (parsed.code === 40003) {
            yield { type: 'error', code: 40003, message: 'Token invalid' };
            return;
          }
          if (parsed.code === 40004) {
            yield { type: 'error', code: 40004, message: 'Account banned' };
            return;
          }
          if (parsed.code === 40301) {
            yield { type: 'error', code: 40301, message: 'Session rate limited' };
            return;
          }
          if (parsed.data?.biz_code) {
            yield { type: 'error', code: parsed.data.biz_code, message: parsed.data.biz_msg || 'DeepSeek biz error' };
            return;
          }

          if (parsed.request_message_id != null) {
            messageIds.requestMessageId = parsed.request_message_id;
            messageIds.responseMessageId = parsed.response_message_id;
          }

          let emitted = false;

          if (parsed.v?.response?.fragments) {
            for (const frag of parsed.v.response.fragments) {
              if (frag.type === 'THINK') {
                currentFragmentType = 'THINK';
                if (frag.content) {
                  yield { type: 'thinking', content: frag.content, messageIds };
                  emitted = true;
                }
              } else if (frag.type === 'RESPONSE') {
                currentFragmentType = 'RESPONSE';
                if (frag.content) {
                  yield { type: 'content', content: frag.content, messageIds };
                  emitted = true;
                }
              }
            }
            if (parsed.v.response.accumulated_token_usage != null) {
              yield { type: 'usage', usage: parsed.v.response.accumulated_token_usage, messageIds };
            }
          }

          const contentPathRx = /^(?:response\/)?fragments\/-?\d+\/content$/;
          const statusPathRx = /^(?:response\/)?fragments\/-?\d+\/status$/;

          if (parsed.p && parsed.o) {
            if (contentPathRx.test(parsed.p) && typeof parsed.v === 'string') {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
              emitted = true;
            } else if (/^(?:response\/)?status$/.test(parsed.p) && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (statusPathRx.test(parsed.p) && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (/^response$/.test(parsed.p) && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item.p === 'accumulated_token_usage') {
                  yield { type: 'usage', usage: item.v, messageIds };
                }
              }
            } else if (/^(?:response\/)?fragments$/.test(parsed.p) && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                if (frag.type === 'RESPONSE') {
                  currentFragmentType = 'RESPONSE';
                  if (frag.content) {
                    yield { type: 'content', content: frag.content, messageIds };
                  emitted = true;
                  }
                } else if (frag.type === 'THINK') {
                  currentFragmentType = 'THINK';
                  if (frag.content) {
                    yield { type: 'thinking', content: frag.content, messageIds };
                  emitted = true;
                  }
                }
              }
            }
            // Catch-all inside p&&o: if v is a non-control string that didn't
            // match known paths, yield it as content. This handles alternative
            // path formats that different model types may use.
            if (!emitted && typeof parsed.v === 'string' && !/^(FINISHED|SEARCH|BATCH|CANCEL|DONE)$/i.test(parsed.v)) {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
              emitted = true;
            }
            continue;
          }

          // Content deltas with p set but o missing/falsy.
          if (contentPathRx.test(parsed.p) && typeof parsed.v === 'string') {
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            emitted = true;
          }

          // FINISHED without o field — flexible path matching.
          if (/^(?:response\/)?status$/.test(parsed.p) && parsed.v === 'FINISHED') {
            yield { type: 'done', messageIds };
          }
          if (statusPathRx.test(parsed.p) && parsed.v === 'FINISHED') {
            yield { type: 'done', messageIds };
          }

          // Content deltas with NO `p` field are plain text chunks.
          // If a direct `type` field is present (e.g. {"v":"text","type":"THINK"}),
          // use it to set currentFragmentType. Otherwise rely on the tracked state.
          if (typeof parsed.v === 'string' && !parsed.p) {
            const inlineType = parsed.type === 'THINK' ? 'THINK' : parsed.type === 'RESPONSE' ? 'RESPONSE' : null;
            if (inlineType) currentFragmentType = inlineType;
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            emitted = true;
          }

          if (Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (item.p === 'accumulated_token_usage') {
                yield { type: 'usage', usage: item.v, messageIds };
              }
            }
          }

          // OpenAI-style delta format (some model types return this directly):
          // {"choices":[{"delta":{"content":"..."}}]}
          // {"choices":[{"delta":{"reasoning_content":"..."}}]}
          if (Array.isArray(parsed.choices) && parsed.choices[0]?.delta) {
            const delta = parsed.choices[0].delta;
            if (typeof delta.reasoning_content === 'string') {
              currentFragmentType = 'THINK';
              yield { type: 'thinking', content: delta.reasoning_content, messageIds };
              emitted = true;
            } else if (typeof delta.content === 'string') {
              currentFragmentType = 'RESPONSE';
              yield { type: 'content', content: delta.content, messageIds };
              emitted = true;
            }
            if (parsed.choices[0].finish_reason === 'stop') {
              yield { type: 'done', messageIds };
            }
            if (parsed.choices[0].finish_reason === 'tool_calls') {
              yield { type: 'done', messageIds };
            }
          }

          // Direct finish_reason at top level (alternative format).
          if (parsed.finish_reason === 'stop' || parsed.finish_reason === 'tool_calls') {
            yield { type: 'done', messageIds };
          }

          // === Universal content fallback ===
          // If v is a plain string that reached here (no path matched, no p field,
          // not handled by any format-specific branch above), emit it generically.
          // This catches format variations across model types.
          if (!emitted && typeof parsed.v === 'string' && parsed.v.length > 0 && !/^(FINISHED|SEARCH|BATCH|CANCEL|DONE|stop)$/i.test(parsed.v)) {
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
