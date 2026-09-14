import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { srcPath, appRootPath } from '../src/utils/runtime-paths.js';

test('Web 服务静态资源包含首页与前端工程', () => {
  // 后端托管的静态页
  assert.ok(existsSync(srcPath('performance', 'index.html')));
  assert.ok(existsSync(srcPath('public', 'index.html')));
  assert.ok(existsSync(srcPath('sha3_wasm_bg.wasm')));

  // 管理后台前端工程（构建产物 src/admin/dist 不入库，由 npm run build 生成）
  assert.ok(existsSync(appRootPath('web', 'index.html')));
  assert.ok(existsSync(appRootPath('web', 'src', 'main.tsx')));
});

test('若管理后台已构建，则产物入口存在', () => {
  const distIndex = srcPath('admin', 'dist', 'index.html');
  if (!existsSync(distIndex)) return; // 未构建时跳过，CI 单独跑 build
  assert.ok(existsSync(distIndex));
  assert.ok(existsSync(srcPath('admin', 'dist', 'assets')));
});

test('源码路径基于模块位置解析，与启动时的工作目录无关', () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.ok(isAbsolute(srcPath('public', 'index.html')));
    assert.ok(existsSync(srcPath('public', 'index.html')));
    assert.ok(existsSync(appRootPath('package.json')));
  } finally {
    process.chdir(originalCwd);
  }
});
