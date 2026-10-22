'use strict';

/**
 * Sanity-checks the electron-builder output before CI uploads or publishes it.
 *
 * Catches the failure modes that are easy to miss on a green build:
 *   - a target that silently did not produce its EXE
 *   - a truncated download / half-written installer
 *   - the native input helper missing from extraResources (app would be
 *     view-only and remote control would never work)
 *   - an app.asar that lost the renderer files (blank window)
 *
 * Run after `npm run dist`:  node scripts/verify-dist.js
 */

const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist');
const MB = 1024 * 1024;
const MIN_INSTALLER_BYTES = 40 * MB; // a real Electron installer is ~75 MB

let failed = 0;

const inActions = process.env.GITHUB_ACTIONS === 'true';

const ok = (message) => console.log(`  ok    ${message}`);
const bad = (message) => {
  failed += 1;
  console.error(`  FAIL  ${message}`);
  // Surface the reason in the Actions UI, where it is visible without logs.
  if (inActions) console.log(`::error title=verify-dist::${message.replace(/[\r\n]+/g, ' ')}`);
};

/** A Windows PE file always starts with "MZ". */
function isPeFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const sig = Buffer.alloc(2);
    fs.readSync(fd, sig, 0, 2, 0);
    fs.closeSync(fd);
    return sig.toString('latin1') === 'MZ';
  } catch {
    return false;
  }
}

function artifacts(prefix, ext) {
  if (!fs.existsSync(dist)) return [];
  return fs
    .readdirSync(dist)
    .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
    .sort();
}

function checkExe(name) {
  const full = path.join(dist, name);
  const size = fs.statSync(full).size;
  if (size < MIN_INSTALLER_BYTES) {
    bad(`${name} is only ${(size / MB).toFixed(1)} MB — the build looks truncated`);
    return;
  }
  if (!isPeFile(full)) {
    bad(`${name} is not a Windows executable`);
    return;
  }
  ok(`${name} · ${(size / MB).toFixed(1)} MB`);
}

function checkHelper() {
  const helper = path.join(dist, 'win-unpacked', 'resources', 'input-helper.exe');
  if (!fs.existsSync(helper)) {
    bad('input-helper.exe is missing from resources/ — remote control would never work');
    return;
  }
  const size = fs.statSync(helper).size;
  // A csc-built helper is tiny (a few KB); what matters is that it is a real PE.
  if (size < 3 * 1024 || !isPeFile(helper)) {
    bad(`input-helper.exe looks broken (${size} bytes, PE=${isPeFile(helper)})`);
    return;
  }
  ok(`input-helper.exe bundled · ${(size / 1024).toFixed(0)} KB`);
}

function checkAsar() {
  const asar = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asar)) {
    bad('resources/app.asar is missing — the app would start with no UI');
    return;
  }
  const buf = fs.readFileSync(asar);
  // The asar index is a plain JSON header at the top of the file.
  const header = buf.subarray(0, Math.min(buf.length, 2 * MB)).toString('utf8');
  const wanted = ['main.js', 'preload.js', 'index.html', 'app.js', 'net.js', 'styles.css'];
  const missing = wanted.filter((file) => !header.includes(`"${file}"`));
  if (missing.length) bad(`app.asar is missing: ${missing.join(', ')}`);
  else ok(`app.asar contains the app (${(buf.length / MB).toFixed(1)} MB)`);
}

function checkMainExe() {
  const exe = path.join(dist, 'win-unpacked', 'ScreenLink.exe');
  if (!fs.existsSync(exe)) {
    bad('win-unpacked/ScreenLink.exe is missing');
    return;
  }
  ok('win-unpacked/ScreenLink.exe present');
}

function main() {
  if (!fs.existsSync(dist)) {
    console.error('dist/ does not exist — run `npm run dist` first');
    process.exit(1);
  }

  console.log('Verifying dist/');
  const installers = artifacts('ScreenLink-Setup-', '.exe');
  const portables = artifacts('ScreenLink-Portable-', '.exe');

  if (!installers.length) bad('the installer target produced no ScreenLink-Setup-*.exe');
  if (!portables.length) bad('the portable target produced no ScreenLink-Portable-*.exe');
  for (const name of [...installers, ...portables]) checkExe(name);

  checkMainExe();
  checkHelper();
  checkAsar();

  if (failed) {
    const listing = fs.readdirSync(dist).join(', ');
    console.error(`\ndist/ contains: ${listing}`);
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll package checks passed.');
}

main();
