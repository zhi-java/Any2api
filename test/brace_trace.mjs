import { readFileSync } from 'fs';
const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');
const lines = src.split('\n');

let depth = 0;
let inStr = false, inTmpl = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j], p = j > 0 ? line[j - 1] : '';
    if (c === '\\' && (inStr || inTmpl)) { j++; continue; }
    if (!inTmpl && c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr && c === '`' && p !== '\\') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;
    if (c === '{') depth++;
    if (c === '}') depth--;
  }

  // Focus on the critical area
  const trimmed = line.trim();
  if (i + 1 >= 468 && i + 1 <= 485) {
    const braces = trimmed.replace(/[^{}]/g, '');
    if (braces) {
      console.log((i + 1) + ' depth=' + depth + ' ' + braces + '  ' + trimmed.slice(0, 60));
    }
  }
}
console.log('\nDepth at line 484 (before thinking):', depth);
console.log('Depth at line 495 (before close thinking):', depth);
console.log('Depth at line 496 (closing for loop):', depth);
