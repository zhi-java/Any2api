import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { srcPath, appRootPath } from '../src/utils/runtime-paths.js';

test('Web 服务静态资源包含管理界面', () => {
  assert.ok(existsSync(srcPath('admin', 'index.html')));
  assert.ok(existsSync(srcPath('admin', 'vendor', 'chart.umd.min.js')));
  assert.ok(existsSync(srcPath('performance', 'index.html')));
  assert.ok(existsSync(srcPath('public', 'index.html')));
  assert.ok(existsSync(srcPath('sha3_wasm_bg.wasm')));
});

test('源码路径基于模块位置解析，与启动时的工作目录无关', () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.ok(isAbsolute(srcPath('admin', 'index.html')));
    assert.ok(existsSync(srcPath('admin', 'index.html')));
    assert.ok(existsSync(appRootPath('package.json')));
  } finally {
    process.chdir(originalCwd);
  }
});
