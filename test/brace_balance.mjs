import { readFileSync } from 'fs';

const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');

// Remove ALL string content before counting braces
let clean = '';
let inStr = false, inTmpl = false, inBlockComment = false, inLineComment = false;

for (let i = 0; i < src.length; i++) {
  const c = src[i];
  const n = i + 1 < src.length ? src[i + 1] : '';

  // Line comment
  if (!inStr && !inTmpl && !inBlockComment && c === '/' && n === '/') { inLineComment = true; continue; }
  if (inLineComment && c === '\n') { inLineComment = false; clean += c; continue; }
  if (inLineComment) continue;

  // Block comment
  if (!inStr && !inTmpl && !inBlockComment && c === '/' && n === '*') { inBlockComment = true; i++; continue; }
  if (inBlockComment && c === '*' && n === '/') { inBlockComment = false; i++; continue; }
  if (inBlockComment) continue;

  // Regex literal (starts after certain operators)
  // String literals
  if (!inTmpl && c === '"' && !inBlockComment) { inStr = !inStr; continue; }
  if (!inStr && c === '`' && !inBlockComment) { inTmpl = !inTmpl; continue; }
  if (inStr || inTmpl) continue;

  clean += c;
}

// Now check brace balance
let depth = 0;
let maxDepth = 0;
const lines = src.split('\n');

let lineCharIndex = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = clean[lineCharIndex++] || '';
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth > maxDepth) maxDepth = depth;
  }
  // skip newline
  lineCharIndex++;

  // Only report at function boundaries
  const trimmed = line.trim();
  if (trimmed.startsWith('export function') || trimmed.startsWith('export async function')) {
    console.log(`Line ${i+1} depth=${depth} ${trimmed.slice(0,60)}`);
  }
}

console.log(`\nFinal: depth=${depth}`);
console.log(depth === 0 ? '✅ BALANCED' : `❌ UNBALANCED (${depth})`);
