/* Maps browser KeyboardEvent.code -> Windows virtual-key code, plus the
 * modifier bookkeeping used to replay shortcuts on the remote machine. */
(function () {
  'use strict';

  const map = {
    Escape: 27, Tab: 9, CapsLock: 20, Space: 32, Backspace: 8,
    Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
    ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
    MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Insert: 45, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
    Backslash: 220, Semicolon: 186, Quote: 222, Backquote: 192,
    Comma: 188, Period: 190, Slash: 191,
    NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
    NumpadDecimal: 110, NumpadDivide: 111,
    NumLock: 144, ScrollLock: 145, PrintScreen: 44, Pause: 19,
  };

  for (let i = 0; i < 26; i += 1) map[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
  for (let i = 0; i <= 9; i += 1) map[`Digit${i}`] = 48 + i;
  for (let i = 0; i <= 9; i += 1) map[`Numpad${i}`] = 96 + i;
  for (let i = 1; i <= 24; i += 1) map[`F${i}`] = 111 + i;

  const MODIFIERS = {
    ControlLeft: 'ctrl', ControlRight: 'ctrl',
    ShiftLeft: 'shift', ShiftRight: 'shift',
    AltLeft: 'alt', AltRight: 'alt',
    MetaLeft: 'meta', MetaRight: 'meta',
  };

  const VK_BY_MOD = { ctrl: 17, shift: 16, alt: 18, meta: 91 };

  function codeToVk(code) {
    return map[code] || 0;
  }

  /**
   * Small state machine that guarantees the remote machine never keeps a
   * modifier key stuck down (a classic remote-control bug).
   */
  class RemoteKeys {
    constructor(send) {
      this.send = send;       // (vk, down) => void
      this.held = new Set();  // modifiers we told the remote to hold
    }

    _down(mod) {
      if (this.held.has(mod)) return;
      this.held.add(mod);
      this.send(VK_BY_MOD[mod], true);
    }

    _up(mod) {
      if (!this.held.has(mod)) return;
      this.held.delete(mod);
      this.send(VK_BY_MOD[mod], false);
    }

    /** Reconcile held modifiers with a KeyboardEvent's modifier flags. */
    syncModifiers(ev) {
      const wanted = {
        ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, meta: ev.metaKey,
      };
      for (const mod of Object.keys(wanted)) {
        if (wanted[mod]) this._down(mod);
        else this._up(mod);
      }
    }

    key(code, down, ev) {
      const mod = MODIFIERS[code];
      if (mod) {
        // modifier keys themselves drive the held set directly
        if (down) this._down(mod); else this._up(mod);
        return;
      }
      const vk = codeToVk(code);
      if (!vk) return;
      if (ev) this.syncModifiers(ev);
      this.send(vk, down);
    }

    releaseAll() {
      for (const mod of Array.from(this.held)) this._up(mod);
      this.held.clear();
    }
  }

  window.VK = { codeToVk, MODIFIERS, VK_BY_MOD, RemoteKeys };
})();
