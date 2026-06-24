import { readFileSync } from 'fs';
const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');
const lines = src.split('\n');

let depth = 0;
let problemLines = [];

function cleanLine(line) {
  let result = '';
  let inStr = false, inTmpl = false, inLC = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = i + 1 < line.length ? line[i + 1] : '';
    if (!inStr && !inTmpl && c === '/' && n === '/') break;
    if (!inTmpl && c === '"') { inStr = !inStr; continue; }
    if (!inStr && c === '`') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;
    result += c;
  }
  return result;
}

for (let i = 0; i < lines.length; i++) {
  const cleaned = cleanLine(lines[i]);
  for (const c of cleaned) {
    if (c === '{') depth++;
    if (c === '}') depth--;
  }

  const trimmed = lines[i].trim();
  if (trimmed.startsWith('export function') || trimmed.startsWith('export async function') || trimmed.startsWith('async function') || trimmed.startsWith('function ') && !trimmed.startsWith('function(')) {
    problemLines.push({ line: i + 1, depth, txt: trimmed.slice(0, 65), marker: 'FN' });
  }
  if (trimmed === '}' && depth === 0) {
    problemLines.push({ line: i + 1, depth, txt: '}', marker: 'CLOSE' });
  }
}

// Find the last time depth was 0 at top level (export)
let exportZero = 0;
for (let i = 0; i < problemLines.length; i++) {
  if (problemLines[i].marker === 'FN' && problemLines[i].depth === 0) {
    exportZero = problemLines[i].line;
  }
}
console.log('Last export at depth 0: line', exportZero);
console.log('First function not at depth 0:');
for (const p of problemLines) {
  if (p.marker === 'FN' && p.depth !== 0) {
    console.log(`  Line ${p.line} depth=${p.depth}: ${p.txt}`);
  }
}

console.log('');
// Show all function entries
for (const p of problemLines) {
  console.log(`  L${String(p.line).padStart(4)} depth=${p.depth} ${p.marker} ${p.txt}`);
}
console.log('Final depth:', depth);
