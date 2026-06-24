import { readFileSync } from 'fs';

const src = readFileSync('C:/Users/Administrator/IdeaProjects/Any2api/src/channels/deepseek/handlers.js', 'utf8');

// Count braces, skipping strings and comments
let depth = 0;
let inStr = false;
let inTmpl = false;
let inLineComment = false;
let maxDepth = 0;

for (const line of src.split('\n')) {
  inLineComment = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    // Line comment
    if (!inStr && !inTmpl && ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (inLineComment) continue;

    // String starts/ends
    if (!inTmpl && ch === '"') { inStr = !inStr; continue; }
    if (!inStr && ch === '`') { inTmpl = !inTmpl; continue; }
    if (inStr || inTmpl) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth > maxDepth) maxDepth = depth;
  }
}

console.log('Final brace depth:', depth);
console.log('Max depth:', maxDepth);
console.log(depth === 0 ? '✅ Balanced' : `❌ Unbalanced (net ${depth})`);

// Now find where the first unmatched brace is
let d2 = 0;
const lines = src.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inLC = false;
  let inS = false;
  let inT = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const nx = j + 1 < line.length ? line[j + 1] : '';
    if (!inS && !inT && ch === '/' && nx === '/') { inLC = true; j++; continue; }
    if (inLC) continue;
    if (!inT && ch === '"') { inS = !inS; continue; }
    if (!inS && ch === '`') { inT = !inT; continue; }
    if (inS || inT) continue;
    if (ch === '{') d2++;
    if (ch === '}') d2--;
  }
  if (d2 < 0) {
    console.log(`Extra } at line ${i + 1}: ${line.trim().slice(0, 60)}`);
    d2 = 0;
  }
  // Check if we dropped to 0 at top-level exports
  const trimmed = line.trim();
  if (trimmed.startsWith('export ') && d2 !== 0) {
    console.log(`❌ At line ${i + 1} (${trimmed.slice(0, 50)}): depth = ${d2} (should be 0)`);
  }
  if (trimmed.startsWith('export ') && d2 === 0) {
    console.log(`✅ At line ${i + 1} (${trimmed.slice(0, 50)}): depth = 0`);
  }
}
