import { readFileSync, writeFileSync } from 'fs';

const filepath = 'C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js';
let src = readFileSync(filepath, 'utf8');
const lines = src.split('\n');

// Count braces ignoring string/template literals
let depth = 0;
let inStr = false, inTmpl = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    const p = j > 0 ? line[j-1] : '';
    if (c === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
}

console.log('Final depth:', depth, depth === 0 ? '✅' : '❌ missing ' + depth + ' closing braces');

// Focus on handleStreamingClaude (lines 413-547)
depth = 0;
let firstLine = 0;
for (let i = 0; i < 412; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j], p = j > 0 ? line[j-1] : '';
    if (c === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
}
console.log('Depth before handleStreamingClaude (line 413):', depth);

// Now count the function body
let funcStart = depth;
for (let i = 412; i < 547; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j], p = j > 0 ? line[j-1] : '';
    if (c === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
}
console.log('Depth after handleStreamingClaude (line 547):', depth);
console.log('Body net braces:', depth - funcStart, '(expected 1 = function itself)');
