import test from 'node:test';
import assert from 'node:assert/strict';

import { collectUploadableParts } from '../src/utils/message-files.js';
import { textFromContent } from '../src/utils/response-utils.js';

test('collectUploadableParts supports OpenAI image_url and file blocks', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'inspect these' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: 'cGRm', mime_type: 'application/pdf' } },
      { type: 'input_file', filename: 'notes.txt', file_data: 'bm90ZXM=', media_type: 'text/plain' },
    ],
  }];

  const files = collectUploadableParts(messages);
  assert.equal(files.length, 3);
  assert.equal(files[0].kind, 'image');
  assert.equal(files[1].filename, 'report.pdf');
  assert.equal(files[1].mimeType, 'application/pdf');
  assert.equal(files[2].filename, 'notes.txt');
});

test('textFromContent renders file blocks as short labels instead of JSON', () => {
  const text = textFromContent([
    { type: 'text', text: 'read' },
    { type: 'file', file: { filename: 'very-long.json', file_data: 'e30=' } },
  ]);

  assert.equal(text, 'read\n[File: very-long.json]');
  assert.doesNotMatch(text, /file_data/);
});

