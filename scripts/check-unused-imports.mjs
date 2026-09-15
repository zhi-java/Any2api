#!/usr/bin/env node
/**
 * 静态检查未使用的具名导入（开发期工具）。
 * 退出码非 0 表示发现问题，便于 CI 接入。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!['dist', 'vendor', 'node_modules'].includes(name)) out.push(...walk(p));
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let issues = 0;

for (const file of walk('src')) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
    const body = source.slice(0, match.index) + source.slice(match.index + match[0].length);
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      const re = new RegExp(`\\b${escapeRe(name)}\\b`);
      if (!re.test(body)) {
        console.log(`  ⚠️  ${file}: 未使用 ${name}`);
        issues++;
      }
    }
  }
}

console.log(issues ? `\n共 ${issues} 处未使用导入` : '  ✅ 无未使用导入');
process.exit(issues ? 1 : 0);
