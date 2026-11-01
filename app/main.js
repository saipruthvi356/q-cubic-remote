// Q-CUBIC Remote - host app (runs on the PC that is controlled)
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const input = require('./input');

let win = null;

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
  win.on('closed', () => { win = null; app.quit(); });
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
});

app.on('window-all-closed', () => app.quit());
