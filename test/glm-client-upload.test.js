import test from 'node:test';
import assert from 'node:assert/strict';

import { glmChatCompletion } from '../src/channels/glm/client.js';

test('glmChatCompletion appends uploaded file blocks to GLM user content', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  const responseStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(responseStream, { status: 200 });
  };

  try {
    const body = await glmChatCompletion([
      { role: 'user', content: [{ type: 'text', text: 'read uploaded file' }] },
    ], {
      assistantId: 'assistant-id',
      tokenManager: {
        async getAccessToken() {
          return 'glm-access-token';
        },
      },
      attachments: [{ filename: 'probe.pdf', data: 'cGRm', mimeType: 'application/pdf', kind: 'file' }],
      uploadFiles: async ({ attachments }) => [{
        type: 'file',
        file: [{
          file_id: 'glm-file-id',
          file_url: 'https://example.com/probe.pdf',
          file_name: attachments[0].filename,
          file_size: 3,
          order: 0,
        }],
      }],
    });

    assert.equal(body, responseStream);
    assert.equal(captured.url, 'https://chatglm.cn/chatglm/backend-api/assistant/stream');
    const payload = JSON.parse(captured.options.body);
    assert.deepEqual(payload.messages[0].content[1], {
      type: 'file',
      file: [{
        file_id: 'glm-file-id',
        file_url: 'https://example.com/probe.pdf',
        file_name: 'probe.pdf',
        file_size: 3,
        order: 0,
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

