import { readFileSync } from 'fs';
const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');

const lines = src.split('\n');

// Check ALL string/template backtick patterns that could cause miscount
let btCount = 0;
let dqCount = 0;
let inStr = false, inTmpl = false;

for (const line of lines) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const p = i > 0 ? line[i-1] : '';
    // Skip escaped quotes
    if (ch === '\\' && (inStr || inTmpl)) { i++; continue; }
    if (!inTmpl && ch === '"' && p !== '\\') {
      inStr = !inStr;
      dqCount++;
    }
    if (!inStr && ch === '`' && p !== '\\') {
      inTmpl = !inTmpl;
      btCount++;
    }
    if (inStr || inTmpl) continue;
  }
}

console.log('Backticks:', btCount, '(even:', btCount % 2 === 0, ')');
console.log('Double quotes line-level:', dqCount);

// Now track depth with proper skipping
let depth = 0;
let inStr2 = false, inTmpl2 = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inLineComment = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const nxt = j + 1 < line.length ? line[j + 1] : '';
    const prv = j > 0 ? line[j - 1] : '';

    // Line comment
    if (!inStr2 && !inTmpl2 && ch === '/' && nxt === '/') break;

    // String/template skip
    if (ch === '\\' && (inStr2 || inTmpl2)) { j++; continue; }
    if (!inTmpl2 && ch === '"' && prv !== '\\') { inStr2 = !inStr2; continue; }
    if (!inStr2 && ch === '`' && prv !== '\\') { inTmpl2 = !inTmpl2; continue; }
    if (inStr2 || inTmpl2) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith('export ')) {
    console.log(`Line ${i+1} depth=${depth}: ${trimmed.slice(0,65)}`);
  }
}
console.log(`\nFinal: ${depth}`);
