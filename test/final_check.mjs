import { readFileSync } from 'fs';

const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');
let depth = 0;
let inStr = false, inTmpl = false;

// Track depth line by line, handling strings and templates
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  const p = i > 0 ? src[i-1] : '';

  if (c === '\\' && (inStr || inTmpl)) { i++; continue; }
  if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
  if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
  if (inStr || inTmpl) continue;

  if (c === '{') depth++;
  if (c === '}') depth--;
}

console.log('Full file final depth:', depth, depth === 0 ? '✅' : '❌');

// Now find where braces create problems with exports
const lines = src.split('\n');
let lineDepth = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  lineDepth = 0;
  inStr = false; inTmpl = false;

  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    const p = j > 0 ? line[j-1] : '';

    if (c === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;

    if (c === '{') lineDepth++;
    if (c === '}') lineDepth--;
  }
  depth += lineDepth;

  const trimmed = line.trim();
  if (trimmed.startsWith('export ')) {
    console.log(`L${i+1} depth=${depth}: ${trimmed.slice(0,60)}`);
  }
  // Check for deep nesting
  if (lineDepth !== 0 && trimmed.includes('}') && trimmed.includes('{')) {
    // line with both, skip
  }
}

console.log('Final depth:', depth);
