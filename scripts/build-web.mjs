#!/usr/bin/env node
/**
 * 构建管理后台前端。
 *
 * 为什么不用 `npm --prefix web install`：在仓库根执行时，npm 10 会把父包
 * 以 `"omni": "file:.."` 的形式注入 web/package.json，形成自引用依赖污染。
 * 这里显式把 cwd 切到 web/ 后调用 npm，避免该行为，并保持跨平台。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function run(args) {
  const result = spawnSync(npm, args, { cwd: webDir, stdio: 'inherit', shell: isWin });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 有 lockfile 时用 ci 保证可复现，否则回落到 install
run(existsSync(resolve(webDir, 'package-lock.json')) ? ['ci'] : ['install']);
run(['run', 'build']);
