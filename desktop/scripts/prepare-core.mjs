#!/usr/bin/env node
/**
 * Prepare portable Core runtime for OmniAPI Desktop.
 *
 * Output under desktop/src-tauri/resources/:
 *   node/node.exe
 *   core/src/index.js
 *   core/node_modules/
 *
 * This avoids requiring end users to install Node. A single-file pkg binary can
 * still be attempted explicitly with --single-file, but portable Node is the
 * default because it does not require a Visual Studio Node build toolchain.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const repoRoot = resolve(desktopRoot, '..');
const resourcesDir = join(desktopRoot, 'src-tauri', 'resources');
const force = process.argv.includes('--force');
const singleFile = process.argv.includes('--single-file');
const isWin = process.platform === 'win32';

const NODE_VERSION = process.env.OMNIAPI_PORTABLE_NODE || 'v20.18.1';

function log(...a) {
  console.log('[prepare-core]', ...a);
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function rimraf(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function hasFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

async function download(url, dest) {
  log('download', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  ensureDir(dirname(dest));
  await pipeline(res.body, createWriteStream(dest));
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
  }
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  if (isWin) {
    const literalZip = zipPath.replace(/'/g, "''");
    const literalDest = destDir.replace(/'/g, "''");
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${literalZip}' -DestinationPath '${literalDest}' -Force`,
    ]);
    return;
  }
  run('unzip', ['-o', zipPath, '-d', destDir]);
}

async function stagePortableNode() {
  const nodeDir = join(resourcesDir, 'node');
  const nodeExe = join(nodeDir, isWin ? 'node.exe' : 'node');
  if (hasFile(nodeExe)) {
    log('reuse portable node', nodeExe);
    return nodeExe;
  }

  if (!isWin) {
    log('non-windows: copy current node binary');
    ensureDir(nodeDir);
    copyFileSync(process.execPath, nodeExe);
    try {
      run('chmod', ['+x', nodeExe]);
    } catch {
      // ignore
    }
    return nodeExe;
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const base = `node-${NODE_VERSION}-win-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.zip`;
  const zipPath = join(resourcesDir, `${base}.zip`);
  const extractRoot = join(resourcesDir, '_node_extract');

  rimraf(extractRoot);
  await download(url, zipPath);
  await extractZip(zipPath, extractRoot);

  const extracted = existsSync(join(extractRoot, base))
    ? join(extractRoot, base)
    : join(extractRoot, readdirSync(extractRoot)[0] || '');
  if (!hasFile(join(extracted, 'node.exe'))) {
    throw new Error(`node.exe not found in ${extracted}`);
  }

  try { rimraf(nodeDir); } catch (e) { log('cannot remove node dir (file locked), will overwrite in place'); }
  ensureDir(nodeDir);
  try { rimraf(join(nodeDir, 'node.exe')); } catch (_) { /* ok */ }
  copyFileSync(join(extracted, 'node.exe'), nodeExe);
  for (const f of ['LICENSE', 'LICENSE.npm', 'README.md']) {
    const src = join(extracted, f);
    if (existsSync(src)) copyFileSync(src, join(nodeDir, f));
  }

  rimraf(extractRoot);
  rmSync(zipPath, { force: true });
  log('wrote portable node', nodeExe);
  return nodeExe;
}

function stageCoreSources() {
  const coreDir = join(resourcesDir, 'core');
  const marker = join(coreDir, 'src', 'index.js');
  if (hasFile(marker) && !force) {
    log('reuse staged core sources', coreDir);
    return coreDir;
  }

  log('stage core sources (overwriting src admin)');
  ensureDir(coreDir);

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const slim = {
    name: 'omniapi-core-runtime',
    version: pkg.version || '1.0.0',
    private: true,
    type: 'module',
    main: 'src/index.js',
    dependencies: pkg.dependencies || {},
  };
  writeFileSync(join(coreDir, 'package.json'), `${JSON.stringify(slim, null, 2)}\n`);
  const srcDest = join(coreDir, 'src');
  if (existsSync(srcDest)) rmSync(srcDest, { recursive: true, force: true });
  cpSync(join(repoRoot, 'src'), srcDest, { recursive: true });
  if (existsSync(join(repoRoot, '.env.example'))) {
    copyFileSync(join(repoRoot, '.env.example'), join(coreDir, '.env.example'));
  }

  run(isWin ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: coreDir,
  });

  log('staged', coreDir);
  return coreDir;
}

function tryPkgBinary() {
  const outName = isWin ? 'omniapi-core.exe' : 'omniapi-core';
  const outPath = join(resourcesDir, outName);
  if (hasFile(outPath) && !force) {
    log('reuse single-file core', outPath);
    return outPath;
  }

  const pkgBin = join(repoRoot, 'node_modules', '.bin', isWin ? 'pkg.cmd' : 'pkg');
  if (!existsSync(pkgBin)) {
    log('pkg not installed, skip single-file binary');
    return null;
  }

  const targets = {
    win32: 'node20-win-x64',
    darwin: process.arch === 'arm64' ? 'node20-macos-arm64' : 'node20-macos-x64',
    linux: 'node20-linux-x64',
  };
  const target = targets[process.platform] || 'node20-linux-x64';
  const tmpOut = join(resourcesDir, isWin ? 'omniapi-core-tmp.exe' : 'omniapi-core-tmp');

  log(`try pkg single-file → ${outName} (${target})`);
  const r = spawnSync(pkgBin, ['src/index.js', '--targets', target, '--output', tmpOut], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWin,
  });
  if (r.status !== 0) {
    log('pkg failed; portable Node runtime remains available');
    return null;
  }

  const produced = hasFile(tmpOut)
    ? tmpOut
    : hasFile(join(resourcesDir, 'omniapi-core-tmp'))
      ? join(resourcesDir, 'omniapi-core-tmp')
      : null;
  if (!produced) return null;

  if (hasFile(outPath)) rmSync(outPath);
  copyFileSync(produced, outPath);
  rmSync(produced, { force: true });
  log('wrote single-file core', outPath);
  return outPath;
}

async function main() {
  ensureDir(resourcesDir);
  writeFileSync(
    join(resourcesDir, 'README.txt'),
    [
      'OmniAPI Desktop resources',
      '',
      'Portable runtime:',
      '  node/node.exe',
      '  core/src/index.js + core/node_modules',
      '',
      'Optional single-file Core:',
      '  omniapi-core.exe (only when prepare-core is run with --single-file)',
      '',
      'Generated by desktop/scripts/prepare-core.mjs',
      '',
    ].join('\n'),
  );

  await stagePortableNode();
  stageCoreSources();

  if (singleFile) {
    tryPkgBinary();
  } else {
    log('skip pkg single-file (use --single-file to attempt it)');
  }

  log('done');
  log('resources:', resourcesDir);
}

main().catch((err) => {
  console.error('[prepare-core] failed:', err);
  process.exit(1);
});
