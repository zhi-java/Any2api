import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Web 服务静态资源包含管理界面', () => {
  assert.ok(packageJson.pkg.assets.includes('src/admin/**/*'));
  assert.ok(packageJson.pkg.assets.includes('src/performance/**/*'));
  assert.ok(packageJson.pkg.assets.includes('src/public/**/*'));
  assert.ok(packageJson.pkg.assets.includes('src/sha3_wasm_bg.wasm'));
  assert.ok(existsSync(new URL('../src/admin/vendor/chart.umd.min.js', import.meta.url)));
  assert.ok(!packageJson.pkg.scripts.includes('src/**/*.js'));
  assert.ok(!packageJson.pkg.scripts.some(pattern => pattern.startsWith('src/admin')));
});
