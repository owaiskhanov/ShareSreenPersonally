/* One API for both the desktop app and a plain browser tab. */
(function () {
  'use strict';

  const native = window.screenLink;
  const LS_KEY = 'screenlink.settings';

  function readWebSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }

  const webBridge = {
    isElectron: false,
    info: async () => ({ isElectron: false, platform: 'web', canInject: false }),
    settings: {
      get: async () => readWebSettings(),
      set: async (patch) => {
        const next = { ...readWebSettings(), ...patch };
        try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      },
    },
    listSources: async () => null, // the browser shows its own picker
    startShare: async () => ({ ok: true }),
    stopShare: async () => ({ ok: true }),
    setControlAllowed: async (allowed) => ({ allowed, helperReady: false }),
    controlState: async () => ({ allowed: false, helperReady: false }),
    sendInput: () => {},
    clipboard: {
      read: async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } },
      write: async (text) => {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
      },
    },
    window: {
      fullscreen: async (on) => {
        try {
          if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
          if (!on && document.fullscreenElement) await document.exitFullscreen();
        } catch { /* ignore */ }
        return Boolean(document.fullscreenElement);
      },
      minimize: async () => {},
    },
    onControlRevoked: () => {},
  };

  window.Bridge = native ? native : webBridge;
})();
