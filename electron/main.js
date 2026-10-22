'use strict';

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, session, clipboard, Menu,
  shell, globalShortcut,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const isWindows = process.platform === 'win32';
const isDev = !app.isPackaged;

let win = null;
let pendingSourceId = null;         // which source getDisplayMedia() should hand back
let sharedDisplay = null;           // { bounds, scaleFactor } of the display being shared
let controlAllowed = false;         // remote input gate — only true after the user allows it
let helper = null;                  // input helper child process
let helperBroken = false;

// Panic button: works even while the friend controls the mouse and keyboard.
const REVOKE_ACCELERATOR = 'Control+Shift+F12';

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('settings write failed', err);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Window                                                             */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'ScreenLink',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // never let a remote page hijack the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.on('closed', () => { win = null; });

  // Closing the window must always release control + stop the helper.
  win.on('close', () => {
    controlAllowed = false;
    killHelper();
    setRevokeHotkey(false);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // Screen capture for getDisplayMedia(), driven by the UI's source picker.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wantAudio = Boolean(request && request.audioRequested);
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = sources.find((s) => s.id === pendingSourceId) || sources[0];
        if (!source) return callback({});
        const opts = { video: source };
        // Windows can share "what you hear" along with the screen.
        if (wantAudio && isWindows) opts.audio = 'loopback';
        callback(opts);
      })
      .catch(() => callback({}));
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  killHelper();
});

app.on('window-all-closed', () => {
  setRevokeHotkey(false);
  killHelper();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killHelper);

/* ------------------------------------------------------------------ */
/* Input helper (native Windows input injection)                       */
/* ------------------------------------------------------------------ */

function helperPath() {
  const name = 'input-helper.exe';
  return isDev
    ? path.join(__dirname, name)
    : path.join(process.resourcesPath, name);
}

function startHelper() {
  if (helper || helperBroken || !isWindows) return helper;
  const exe = helperPath();
  if (!fs.existsSync(exe)) {
    helperBroken = true;
    console.warn('[input] helper not found at', exe);
    return null;
  }
  try {
    helper = spawn(exe, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    helper.on('exit', () => { helper = null; });
    helper.on('error', (err) => {
      console.warn('[input] helper error', err.message);
      helper = null;
      helperBroken = true;
    });
    helper.stdin.on('error', () => { helper = null; });
  } catch (err) {
    console.warn('[input] spawn failed', err.message);
    helper = null;
    helperBroken = true;
  }
  return helper;
}

function setRevokeHotkey(on) {
  try {
    if (on && !globalShortcut.isRegistered(REVOKE_ACCELERATOR)) {
      globalShortcut.register(REVOKE_ACCELERATOR, () => {
        if (!controlAllowed) return;
        controlAllowed = false;
        killHelper();
        if (win && !win.isDestroyed()) win.webContents.send('control:revoked');
      });
    } else if (!on) {
      globalShortcut.unregister(REVOKE_ACCELERATOR);
    }
  } catch (err) {
    console.warn('[hotkey]', err.message);
  }
}

function killHelper() {
  if (!helper) return;
  try { helper.stdin.end(); helper.kill(); } catch { /* ignore */ }
  helper = null;
}

function helperWrite(line) {
  const h = startHelper();
  if (!h || controlAllowed !== true) return false;
  try {
    h.stdin.write(line + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Normalised 0..1 desktop coordinates -> physical pixels on the shared display. */
function toPhysical(nx, ny) {
  const b = sharedDisplay && sharedDisplay.bounds;
  if (!b) return null;
  const scale = sharedDisplay.scaleFactor || 1;
  const x = Math.round((b.x + Math.min(Math.max(nx, 0), 1) * b.width) * scale);
  const y = Math.round((b.y + Math.min(Math.max(ny, 0), 1) * b.height) * scale);
  return [x, y];
}

const MOUSE_FLAGS = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040],
};

function handleInput(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (!controlAllowed) return; // hard gate: nothing reaches the OS until allowed

  switch (evt.t) {
    case 'move': {
      const p = toPhysical(Number(evt.x), Number(evt.y));
      if (p) helperWrite(`MM ${p[0]} ${p[1]}`);
      break;
    }
    case 'btn': {
      const pair = MOUSE_FLAGS[evt.button];
      if (!pair) break;
      helperWrite(`MB ${evt.down ? 0 : 1} ${evt.button}`);
      break;
    }
    case 'wheel': {
      const dy = Math.max(-10, Math.min(10, Math.round(Number(evt.dy) || 0)));
      const dx = Math.max(-10, Math.min(10, Math.round(Number(evt.dx) || 0)));
      if (dy) helperWrite(`MW ${dy * 120} 0`);
      if (dx) helperWrite(`MW 0 ${dx * 120}`);
      break;
    }
    case 'key': {
      const vk = Number(evt.vk);
      if (!Number.isInteger(vk) || vk < 1 || vk > 255) break;
      helperWrite(`${evt.down ? 'KD' : 'KU'} ${vk}`);
      break;
    }
    case 'clip': {
      const text = typeof evt.text === 'string' ? evt.text.slice(0, 400_000) : '';
      helperWrite(`CLIP ${Buffer.from(text, 'utf8').toString('base64')}`);
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  isElectron: true,
  canInject: isWindows && !helperBroken,
  serverDefault: process.env.SCREENLINK_SERVER || '',
}));

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch || {}));

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    displayId: s.display_id || '',
    isScreen: s.id.startsWith('screen:'),
    thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('share:start', (_e, { sourceId, displayId }) => {
  pendingSourceId = sourceId || null;
  const displays = screen.getAllDisplays();
  const match = displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  sharedDisplay = { bounds: match.bounds, scaleFactor: match.scaleFactor };
  controlAllowed = false;
  return { ok: true, bounds: sharedDisplay.bounds, scaleFactor: sharedDisplay.scaleFactor };
});

ipcMain.handle('share:stop', () => {
  pendingSourceId = null;
  sharedDisplay = null;
  controlAllowed = false;
  killHelper();
  return { ok: true };
});

ipcMain.handle('control:set', (_e, allowed) => {
  const next = Boolean(allowed);

  if (next) {
    controlAllowed = true;
    setRevokeHotkey(true);
    startHelper();
  } else {
    // Release every key the friend may be holding *while* writes are still
    // accepted, otherwise a modifier could stay stuck on the user's machine.
    if (controlAllowed) {
      for (let vk = 8; vk <= 255; vk += 1) helperWrite(`KU ${vk}`);
    }
    controlAllowed = false;
    setRevokeHotkey(false);
    setTimeout(killHelper, 300);
  }

  return { allowed: controlAllowed, helperReady: Boolean(helper) };
});

ipcMain.handle('control:state', () => ({ allowed: controlAllowed, helperReady: Boolean(helper) }));

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('window:fullscreen', (_e, on) => {
  if (!win) return false;
  win.setFullScreen(Boolean(on));
  return win.isFullScreen();
});

ipcMain.handle('window:minimize', () => { win && win.minimize(); });

// forward renderer-side input events
ipcMain.on('input:event', (_e, evt) => handleInput(evt));
