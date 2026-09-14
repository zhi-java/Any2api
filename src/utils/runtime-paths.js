import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// 部署形态只有本地与 Docker 两种：源码目录始终随进程一起分发，
// 因此路径基于模块位置解析，而不是依赖启动时的当前工作目录。
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = resolve(SRC_DIR, '..');

export function srcPath(...segments) {
  return resolve(SRC_DIR, ...segments);
}

export function appRootPath(...segments) {
  return resolve(APP_ROOT, ...segments);
}
