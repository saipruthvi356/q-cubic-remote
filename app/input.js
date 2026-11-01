// Q-CUBIC Remote - mouse and keyboard on the host PC (Windows user32 calls)
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

let user32 = null;
let api = null;

if (process.platform === 'win32') {
  const koffi = require('koffi');
  user32 = koffi.load('user32.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

  api = {
    SetCursorPos: user32.func('int __stdcall SetCursorPos(int X, int Y)'),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)'),
    INPUT_SIZE: koffi.sizeof(INPUT),
  };
}

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF = { LEFTDOWN: 0x2, LEFTUP: 0x4, RIGHTDOWN: 0x8, RIGHTUP: 0x10, WHEEL: 0x800 };
const KEYEVENTF = { KEYUP: 0x2, UNICODE: 0x4 };
const VK = {
  Enter: 0x0D, Backspace: 0x08, Tab: 0x09, Escape: 0x1B, Delete: 0x2E, Home: 0x24, End: 0x23,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, PageUp: 0x21, PageDown: 0x22,
  Win: 0x5B, Control: 0x11, Alt: 0x12, Shift: 0x10, F5: 0x74,
};

function mouse(flags, data = 0) {
  api.SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, api.INPUT_SIZE);
}

function key(vk, up) {
  api.SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF.KEYUP : 0, time: 0, dwExtraInfo: 0 } } }, api.INPUT_SIZE);
}

function unicodeChar(code) {
  for (const up of [false, true]) {
    api.SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF.UNICODE | (up ? KEYEVENTF.KEYUP : 0), time: 0, dwExtraInfo: 0 } } }, api.INPUT_SIZE);
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function moveTo(ev, bounds, scale) {
  const x = clamp01(ev.x);
  const y = clamp01(ev.y);
  if (x === null || y === null) return;
  const px = Math.round((bounds.x + x * (bounds.width - 1)) * scale);
  const py = Math.round((bounds.y + y * (bounds.height - 1)) * scale);
  api.SetCursorPos(px, py);
}

function button(b, down) {
  if (b === 'right') mouse(down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP);
  else mouse(down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP);
}

// ev comes from the paired phone; every field is checked before use.
function handle(ev, bounds, scale) {
  if (!ev || typeof ev !== 'object') return;
  if (!api) { // not Windows: log only (used for testing)
    if (process.env.QCR_DEBUG) console.log('[input]', JSON.stringify(ev));
    return;
  }
  try {
    switch (ev.t) {
      case 'move': moveTo(ev, bounds, scale); break;
      case 'down': moveTo(ev, bounds, scale); button(ev.b, true); break;
      case 'up': moveTo(ev, bounds, scale); button(ev.b, false); break;
      case 'click': moveTo(ev, bounds, scale); button(ev.b, true); button(ev.b, false); break;
      case 'dbl': moveTo(ev, bounds, scale); for (let i = 0; i < 2; i++) { button('left', true); button('left', false); } break;
      case 'wheel': {
        const notches = Math.max(-10, Math.min(10, Math.trunc(Number(ev.d) || 0)));
        if (notches) mouse(MOUSEEVENTF.WHEEL, notches * 120);
        break;
      }
      case 'text': {
        const s = String(ev.s || '').slice(0, 500);
        for (const ch of s) {
          if (ch === '\n') { key(VK.Enter, false); key(VK.Enter, true); continue; }
          const cp = ch.codePointAt(0);
          if (cp > 0xFFFF) { // emoji and other characters outside the basic plane: send as a surrogate pair
            const hi = 0xD800 + ((cp - 0x10000) >> 10);
            const lo = 0xDC00 + ((cp - 0x10000) & 0x3FF);
            unicodeChar(hi); unicodeChar(lo);
          } else {
            unicodeChar(cp);
          }
        }
        break;
      }
      case 'key': {
        const vk = VK[ev.k];
        if (vk) { key(vk, false); key(vk, true); }
        break;
      }
      case 'combo': { // e.g. ['Control','c']
        const parts = Array.isArray(ev.keys) ? ev.keys.slice(0, 4) : [];
        const codes = parts.map((k) => VK[k] || (typeof k === 'string' && /^[a-zA-Z0-9]$/.test(k) ? k.toUpperCase().charCodeAt(0) : 0)).filter(Boolean);
        codes.forEach((c) => key(c, false));
        codes.slice().reverse().forEach((c) => key(c, true));
        break;
      }
      default: break;
    }
  } catch (e) {
    console.error('input error', e);
  }
}

module.exports = { handle };
