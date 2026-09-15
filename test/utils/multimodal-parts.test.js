import test from 'node:test';
import assert from 'node:assert/strict';

import { collectUploadableParts, extensionFromName } from '../../src/utils/message-files.js';

// ---------------------------------------------------------------------------
// 多模态输入的附件解析。
//
// 关键缺陷（实测）：data URL 形式的图片，文件名曾被解析成形如
//   "png;base64,iVBORw0KGgo..."
// 因为 new URL('data:image/png;base64,...') 会把整段 base64 当作 pathname。
// 上游按扩展名判定文件类型，遇到这种畸形文件名直接返回
//   biz_code=9 unsupported file type
// 于是图片被静默丢弃（catch 只打日志），prompt 里只剩 "[Image]" 占位符，
// 模型回复"我没有看到图片"。
// ---------------------------------------------------------------------------

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('data URL 图片的文件名由 mimeType 推导，不混入 base64', () => {
  const parts = collectUploadableParts([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'image');
  assert.equal(parts[0].filename, 'image.png', '文件名应为 image.png');
  assert.equal(parts[0].mimeType, 'image/png');
  assert.ok(!parts[0].filename.includes('base64'), '文件名不得混入 base64');
  assert.ok(!parts[0].filename.includes('iVBOR'), '文件名不得混入 base64 内容');
});

test('各种图片 mimeType 都能推出正确扩展名', () => {
  const cases = [
    ['image/jpeg', 'image.jpg'],
    ['image/gif', 'image.gif'],
    ['image/webp', 'image.webp'],
    ['image/bmp', 'image.bmp'],
  ];
  for (const [mime, expected] of cases) {
    const parts = collectUploadableParts([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${PNG_B64}` } }] },
    ]);
    assert.equal(parts[0].filename, expected, `${mime} 应推导为 ${expected}`);
    assert.ok(extensionFromName(parts[0].filename), '必须带扩展名');
  }
});

test('普通 URL 图片仍从路径取文件名', () => {
  const parts = collectUploadableParts([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/pics/cat.png' } }] },
  ]);
  assert.equal(parts[0].filename, 'cat.png');
  assert.equal(parts[0].url, 'https://example.com/pics/cat.png');
  assert.equal(parts[0].data, undefined);
});

test('image_url 为字符串形式同样支持', () => {
  const parts = collectUploadableParts([
    { role: 'user', content: [{ type: 'image_url', image_url: `data:image/png;base64,${PNG_B64}` }] },
  ]);
  assert.equal(parts[0].filename, 'image.png');
  assert.equal(parts[0].mimeType, 'image/png');
});

test('纯文本消息不产生附件', () => {
  const parts = collectUploadableParts([
    { role: 'user', content: '这里没有图片' },
    { role: 'user', content: [{ type: 'text', text: '也没有' }] },
  ]);
  assert.equal(parts.length, 0);
});
