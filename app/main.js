// Q-CUBIC Remote - host app (runs on the PC that is controlled)
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const input = require('./input');

let win = null;
let tray = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- saved settings: this PC's ID and the phones it trusts ----------
function configPath() { return path.join(app.getPath('userData'), 'qcubic-config.json'); }

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  if (!/^[1-9]\d{8}$/.test(cfg.deviceId || '')) {
    cfg.deviceId = String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  }
  if (!Array.isArray(cfg.trusted)) cfg.trusted = [];
  saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

let config = null;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    show: false,
    icon: iconImage(64),
    resizable: false,
    title: 'Q-CUBIC Remote',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'host.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  // Closing the window keeps Q-CUBIC running in the tray, so your phone can still connect.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function iconImage(size) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon-192.png'));
  return img.isEmpty() ? img : img.resize({ width: size, height: size });
}

// Start with Windows (after you log in), hidden in the tray.
function setAutoStart(on) {
  if (!app.isPackaged && process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}
function autoStartOn() { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; }

function createTray() {
  tray = new Tray(iconImage(16));
  tray.setToolTip('Q-CUBIC Remote - ready for your phone');
  const build = () => Menu.buildFromTemplate([
    { label: 'Show Q-CUBIC Remote', click: () => { win.show(); win.focus(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: autoStartOn(), click: (i) => { setAutoStart(i.checked); config.autoStart = i.checked; saveConfig(config); } },
    { type: 'separator' },
    { label: 'Quit (phone can no longer connect)', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(build());
  tray.on('click', () => { win.show(); win.focus(); });
  tray.on('right-click', () => tray.setContextMenu(build()));
}

app.whenReady().then(() => {
  config = loadConfig();

  // Let the host window capture the whole primary screen without a picker.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const primaryId = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === primaryId) || sources[0];
      callback({ video: src });
    }).catch(() => callback({}));
  });

  ipcMain.handle('info', () => ({
    deviceId: config.deviceId,
    trusted: config.trusted.map((t) => ({ kid: t.kid, secret: t.secret, name: t.name })),
    hostName: os.hostname(),
    brokers: process.env.QCR_BROKERS ? process.env.QCR_BROKERS.split(',') : null,
    debug: !!process.env.QCR_DEBUG,
  }));
  ipcMain.handle('add-trusted', (_e, t) => {
    if (!t || typeof t.secret !== 'string' || typeof t.kid !== 'string') return false;
    config.trusted = config.trusted.filter((x) => x.kid !== t.kid);
    config.trusted.push({ kid: t.kid, secret: t.secret, name: String(t.name || 'Phone').slice(0, 60), added: new Date().toISOString() });
    saveConfig(config);
    return true;
  });
  ipcMain.handle('clear-trusted', () => { config.trusted = []; saveConfig(config); return true; });
  ipcMain.on('log', (_e, text) => { if (process.env.QCR_DEBUG) console.log('[host]', text); });
  ipcMain.on('input', (_e, ev) => {
    const d = screen.getPrimaryDisplay();
    input.handle(ev, d.bounds, d.scaleFactor);
  });

  createWindow();
  createTray();
  if (config.autoStart !== false) setAutoStart(true);    // on by default
  powerSaveBlocker.start('prevent-app-suspension');      // keep the PC reachable
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });

// Keep running in the tray when the window is closed.
app.on('window-all-closed', () => {});
