#!/usr/bin/env node
/**
 * Post-build: make NSIS-created desktop/start-menu shortcuts use the bundled
 * multi-resolution icon directly instead of relying on icon extraction from the EXE.
 *
 * This fixes Windows desktop shortcuts showing a default/incorrect icon after install.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const nsiPath = join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi');
const nsisOut = join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'nsis-output.exe');
const finalInstaller = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'OmniAPI_0.1.0_x64-setup.exe');
const makensis = join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');

if (!existsSync(nsiPath)) {
  console.log('[patch-shortcut-icons] NSIS script not found, skipping:', nsiPath);
  process.exit(0);
}
if (!existsSync(makensis)) {
  console.log('[patch-shortcut-icons] makensis.exe not found, skipping:', makensis);
  process.exit(0);
}

let content = readFileSync(nsiPath, 'utf8');
const iconArg = '"" "$INSTDIR\\resources\\icon.ico"';

function patchShortcut(line) {
  if (!line.includes('CreateShortcut ')) return line;
  if (!line.includes('${PRODUCTNAME}.lnk')) return line;
  if (line.includes('resources\\icon.ico') || line.includes('resources\icon.ico')) return line;
  return line.replace(/("\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe")/, `$1 ${iconArg}`);
}

content = content.split(/\r?\n/).map(patchShortcut).join('\r\n');
writeFileSync(nsiPath, content, 'utf8');
console.log('[patch-shortcut-icons] Patched NSIS shortcuts to use resources\\icon.ico');

execFileSync(makensis, ['installer.nsi'], {
  cwd: dirname(nsiPath),
  stdio: 'inherit',
});

if (existsSync(nsisOut)) {
  copyFileSync(nsisOut, finalInstaller);
  console.log('[patch-shortcut-icons] Repacked installer:', finalInstaller);
}
