export async function* parseQwenStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEmitted = false;
  let lastPhaseStatus = '';
  let answerContentSeen = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          doneEmitted = true;
          yield { type: 'done' };
          continue;
        }

        const events = parseQwenEvent(data, lastPhaseStatus, { answerContentSeen });
        if (events.lastPhaseStatus) lastPhaseStatus = events.lastPhaseStatus;
        answerContentSeen = events.answerContentSeen;
        for (const event of events.items) {
          if (event.type === 'done') doneEmitted = true;
          yield event;
          if (event.type === 'done') return;
        }
      }
    }

    const leftover = buffer.trim();
    if (leftover.startsWith('data:')) {
      const data = leftover.slice(5).trim();
      if (data && data !== '[DONE]') {
        const events = parseQwenEvent(data, lastPhaseStatus, { answerContentSeen });
        answerContentSeen = events.answerContentSeen;
        for (const event of events.items) yield event;
      }
    }

    if (!doneEmitted) yield { type: 'done', finishReason: 'stop' };
  } finally {
    reader.releaseLock();
  }
}

export function parseQwenEvent(data, previousPhaseStatus = '', options = {}) {
  const items = [];
  let lastPhaseStatus = previousPhaseStatus;
  let answerContentSeen = Boolean(options.answerContentSeen);

  let parsed;
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return { items, lastPhaseStatus, answerContentSeen };
  }

  if (parsed['response.created'] || parsed['response.info']) {
    return { items, lastPhaseStatus, answerContentSeen };
  }

  if (!Array.isArray(parsed.choices)) {
    return { items, lastPhaseStatus, answerContentSeen };
  }

  for (const choice of parsed.choices) {
    const delta = choice.delta;
    if (!delta) continue;

    const phase = delta.phase;
    const status = delta.status;
    const content = delta.content || '';
    const usage = parsed.usage;

    const key = `${phase}:${status}`;
    if (key === lastPhaseStatus && status === 'typing' && !content) continue;
    lastPhaseStatus = key;

    if (phase === 'answer') {
      if (content) {
        answerContentSeen = true;
        items.push({ type: 'content', content, usage });
      }
      // Qwen can emit empty answer/finished lifecycle events before a later
      // answer stream. Treat only a finish after answer content as terminal;
      // otherwise callers may stop before any正文/body text arrives.
      if (status === 'finished' && answerContentSeen) {
        items.push({ type: 'done', usage, finishReason: 'stop' });
      }
      continue;
    }

    if (phase === 'image_gen') {
      if (status !== 'finished' && content) items.push({ type: 'image', content, usage });
      continue;
    }

    const researchPhases = new Set(['ResearchNotice', 'ResearchPlanning', 'ResearchSearching', 'ResearchReading', 'Writing']);
    if (researchPhases.has(phase)) {
      if (status === 'finished' && !content) continue;
      const extra = delta.extra || {};
      const drInfo = extra.deep_research || {};
      const stage = drInfo.stage || phase;
      if (content) items.push({ type: 'research', content, stage, usage });
      continue;
    }

    if (phase === 'thinking_summary') {
      if (status === 'finished') continue;
      const extra = delta.extra || {};
      const summaryTitle = extra.summary_title?.content?.join('') || '';
      const summaryThought = extra.summary_thought?.content?.join('') || '';
      const thinkingContent = summaryThought || summaryTitle || content;
      if (thinkingContent) items.push({ type: 'thinking', content: thinkingContent, usage });
      continue;
    }

  }

  return { items, lastPhaseStatus, answerContentSeen };
}
