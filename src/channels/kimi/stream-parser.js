function parseFramePayload(text, flags) {
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return [];
  }

  if (flags === 2) {
    if (parsed.error) {
      return [{ type: 'error', message: parsed.error.message || parsed.error.code || JSON.stringify(parsed.error) }];
    }
    return [{ type: 'done' }];
  }

  if (parsed.done) return [{ type: 'done' }];
  if (parsed.error) return [{ type: 'error', message: parsed.error.message || parsed.error.code || JSON.stringify(parsed.error) }];

  const blockError = parsed.block?.exception?.error;
  if (blockError) {
    return [{
      type: 'error',
      message: blockError.localizedMessage?.message
        || blockError.message
        || blockError.reason
        || JSON.stringify(blockError),
    }];
  }

  const events = [];
  const textContent = parsed.block?.text?.content;
  if (typeof textContent === 'string' && textContent) {
    events.push({ type: 'content', content: textContent });
  }

  const reasoningContent = parsed.block?.reasoning?.content || parsed.block?.thinking?.content;
  if (typeof reasoningContent === 'string' && reasoningContent) {
    events.push({ type: 'thinking', content: reasoningContent });
  }

  return events;
}

export async function* parseKimiStream(body) {
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);
  let doneEmitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);

      while (buffer.length >= 5) {
        const flags = buffer[0];
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;

        const text = buffer.subarray(5, 5 + length).toString('utf-8');
        buffer = buffer.subarray(5 + length);

        const events = parseFramePayload(text, flags);
        for (const event of events) {
          if (event.type === 'done') doneEmitted = true;
          yield event;
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'done') return;
        }
      }
    }

    if (!doneEmitted) yield { type: 'done' };
  } finally {
    reader.releaseLock();
  }
}

export function parseKimiFrameForTest(text, flags = 0) {
  return parseFramePayload(text, flags);
}
