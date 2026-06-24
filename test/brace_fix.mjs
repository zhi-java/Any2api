import { readFileSync } from 'fs';
const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');
const lines = src.split('\n');

// Track depth properly, skipping strings/templates
let depth = 0;
let lineInfo = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inStr = false, inTmpl = false;
  let before = depth;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const p = j > 0 ? line[j-1] : '';
    if (ch === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && ch === '"' && p !== '\\') inStr = !inStr;
    if (!inStr && ch === '`' && p !== '\\') inTmpl = !inTmpl;
    if (inStr || inTmpl) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }

  const trimmed = line.trim();
  if (trimmed.includes('handleStreaming') || trimmed.endsWith('}) {') ||
      (depth !== (before - (trimmed.split('}').length - 1) + (trimmed.split('{').length - 1)) && trimmed.match(/[{}]/))) {
    // Show lines near boundaries
  }

  if (i === 224 || i === 319 || i === 320) {
    console.log(`Line ${i+1} depth=${depth}: ${trimmed.slice(0,70)}`);
  }
}

console.log(`\nFinal depth: ${depth}`);
console.log(`Expected: 0`);
