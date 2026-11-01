// Q-CUBIC Remote - phone app logic
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

const N = window.QCRNet;
const $ = (id) => document.getElementById(id);
const STORE = 'qcr.pcs.v1';
const QUALITY_LABEL = { fast: 'Smooth', balanced: 'HD', sharp: 'Ultra' };

// For local testing only: allow a relay override when the page runs on this computer.
const brokers = (() => {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const p = new URLSearchParams(location.search).get('relay');
  return isLocal && p ? p.split(',') : N.BROKERS;
})();

let relays = [], pc = null, channel = null;
let quality = 'balanced';
let attempt = 0;   // only the newest connection attempt may report a timeout

// ---------- saved PCs ----------
function loadPcs() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch (e) { return []; } }
function savePcs(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {} }
function fmtId(id) { return id.slice(0, 3) + ' ' + id.slice(3, 6) + ' ' + id.slice(6); }

function renderPcs() {
  const list = loadPcs();
  const box = $('pcList');
  box.innerHTML = '';
  $('emptyHint').style.display = list.length ? 'none' : 'block';
  list.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '10px';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = p.name || 'My PC';
    const id = document.createElement('div'); id.className = 'id'; id.textContent = fmtId(p.id);
    grow.append(name, id);
    const go = document.createElement('button'); go.className = 'primary'; go.textContent = 'Connect';
    go.onclick = () => connect({ id: p.id, secret: p.secret, name: p.name }, $('homeMsg'));
    const rm = document.createElement('button'); rm.className = 'remove'; rm.textContent = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + (p.name || 'PC'));
    rm.onclick = () => { const l = loadPcs(); l.splice(i, 1); savePcs(l); renderPcs(); };
    card.append(grow, go, rm);
    box.appendChild(card);
  });
}

function show(page) {
  ['home', 'add'].forEach((p) => $(p).classList.toggle('show', p === page));
  $('view').style.display = page === 'view' ? 'flex' : 'none';
}

// ---------- add a PC ----------
function checkAdd() {
  $('pcId').value = $('pcId').value.replace(/[^\d ]/g, '');
  $('pcCode').value = $('pcCode').value.replace(/\D/g, '').slice(0, 6);
  $('pairBtn').disabled = !(N.cleanId($('pcId').value).length === 9 && $('pcCode').value.length === 6);
}
$('pcId').addEventListener('input', checkAdd);
$('pcCode').addEventListener('input', checkAdd);
$('addBtn').onclick = () => { $('addMsg').textContent = ''; show('add'); };
$('cancelAdd').onclick = () => show('home');
$('pairBtn').onclick = () => connect({
  id: N.cleanId($('pcId').value), code: $('pcCode').value, name: $('pcName').value.trim() || 'My PC',
}, $('addMsg'));

// ---------- connecting ----------
function closeRelays() { relays.forEach((r) => r.close()); relays = []; }

async function connect(target, msgEl) {
  msgEl.style.color = '#C7D3E6';
  msgEl.textContent = 'Finding your PC...';
  closeRelays();
  const myAttempt = ++attempt;
  const pairing = !target.secret;
  const key = pairing ? await N.pairKey(target.id, target.code) : await N.trustKey(target.secret);
  const kid = pairing ? null : await N.keyId(target.secret);
  const tp = await N.topics(target.id);
  const sid = N.hex(N.randomBytes(12));
  let answered = false;

  const onMsg = async (topic, payload, relay) => {
    if (answered || myAttempt !== attempt || topic !== tp.outbox(sid)) return;
    let msg;
    try { msg = await N.open(key, JSON.parse(payload)); } catch (e) { return; }
    if (msg.type !== 'offer' || answered) return;
    answered = true;
    msgEl.textContent = 'Connecting to ' + (msg.hostName || 'your PC') + '...';
    try { await answer(msg.sdp, relay, tp, sid, key, kid, target, msgEl); }
    catch (e) { fail(msgEl, 'Connection error: ' + e.message); }
  };

  const hello = { type: 'hello', ts: Date.now(), name: phoneName() };
  const env = Object.assign({ sid }, kid ? { kid } : {}, await N.seal(key, hello));
  let online = 0;
  await Promise.all(brokers.map(async (url) => {
    const r = new N.Relay(url);
    r.onMessage(onMsg);
    r.subscribe(tp.outbox(sid));
    try { await r.connect(); relays.push(r); online++; r.publish(tp.inbox, JSON.stringify(env)); } catch (e) {}
  }));
  if (!online) return fail(msgEl, 'No internet on this phone, or the relay is blocked.');

  setTimeout(() => {
    if (!answered && myAttempt === attempt) {
      closeRelays();
      fail(msgEl, pairing
        ? 'No answer. Check the PC ID and code, and that Q-CUBIC Remote is open on the PC.'
        : 'Your PC did not answer. Is it on, online, and is Q-CUBIC Remote open?');
    }
  }, 15000);
}

function phoneName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  return m ? m[1].trim().slice(0, 30) : 'Phone';
}

function fail(msgEl, text) { msgEl.style.color = '#FCA5A5'; msgEl.textContent = text; }

async function answer(sdp, relay, tp, sid, key, kid, target, msgEl) {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: N.ICE_SERVERS });
  pc.ontrack = (e) => {
    $('video').srcObject = e.streams[0] || new MediaStream([e.track]);
    lowLatency();
  };
  pc.ondatachannel = (e) => {
    channel = e.channel;
    channel.onopen = () => sendQuality();
    channel.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch (x) { return; }
      if (d.t === 'trust' && typeof d.secret === 'string' && N.cleanId(d.deviceId) === target.id) {
        const list = loadPcs().filter((p) => p.id !== target.id);
        list.unshift({ id: target.id, name: target.name || d.name || 'My PC', secret: d.secret });
        savePcs(list);
        toast('PC saved. Next time just tap Connect.');
      }
    };
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') { closeRelays(); msgEl.textContent = ''; enterView(); }
    if (s === 'failed') { endView(); fail(msgEl, 'Could not reach your PC on this network. Try Wi-Fi or mobile data instead.'); show(pairingPage(target)); }
    if (s === 'disconnected') toast('Connection unstable...');
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  lowLatency();
  await pc.setLocalDescription(await pc.createAnswer());
  await N.waitForIce(pc, 3000);
  const env = Object.assign({ sid }, kid ? { kid } : {}, await N.seal(key, { type: 'answer', sdp: pc.localDescription.sdp }));
  relay.publish(tp.inbox, JSON.stringify(env));
}

function pairingPage(target) { return target.secret ? 'home' : 'add'; }

// Ask the browser to show frames as soon as they arrive (lowest delay).
function lowLatency() {
  if (!pc) return;
  pc.getReceivers().forEach((r) => {
    try { r.jitterBufferTarget = 0; } catch (e) {}
    try { r.playoutDelayHint = 0; } catch (e) {}
  });
}

function endView() {
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  channel = null;
  closeRelays();
  renderPcs();
  show('home');
}

// ---------- settings that stay on this phone ----------
const PREFS = 'qcr.prefs.v2';
const prefs = Object.assign({ control: 'mouse', view: 'auto', quality: 'balanced', rotate: 'any', pad: null }, (() => {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch (e) { return {}; }
})());
quality = prefs.quality;
function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} }

function toast(text) {
  const t = $('toast'); t.textContent = text; t.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 1800);
}
function send(ev) { if (channel && channel.readyState === 'open') channel.send(JSON.stringify(ev)); }
function sendQuality() { send({ t: 'quality', v: quality }); }
function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }

// ---------- the picture: size, zoom and pan ----------
const view = { s: 1, tx: 0, ty: 0, base: { x: 0, y: 0, w: 1, h: 1 } };
const MAX_ZOOM = 6;
const stage = $('stage'), screenEl = $('screen'), video = $('video'), cursorEl = $('cursor');
const cursor = { x: 0.5, y: 0.5 };

function layout() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const vw = video.videoWidth || 1600, vh = video.videoHeight || 900;
  let k;
  // Auto: phone upright -> fill the height (slide sideways to see the rest); phone sideways -> whole screen
  const mode = prefs.view === 'auto' ? (H > W ? 'fill' : 'fit') : prefs.view;
  if (mode === 'fill') k = Math.max(W / vw, H / vh);
  else if (mode === 'original') k = 1 / (window.devicePixelRatio || 1);
  else k = Math.min(W / vw, H / vh);
  const w = vw * k, h = vh * k;
  view.base = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  screenEl.style.left = view.base.x + 'px';
  screenEl.style.top = view.base.y + 'px';
  screenEl.style.width = w + 'px';
  screenEl.style.height = h + 'px';
  applyView();
}

function clampView() {
  const W = stage.clientWidth, H = stage.clientHeight, b = view.base;
  view.s = Math.min(MAX_ZOOM, Math.max(1, view.s));
  const w = b.w * view.s, h = b.h * view.s;
  view.tx = w <= W ? (W - w) / 2 - b.x : Math.min(-b.x, Math.max(W - b.x - w, view.tx));
  view.ty = h <= H ? (H - h) / 2 - b.y : Math.min(-b.y, Math.max(H - b.y - h, view.ty));
}

function applyView() {
  clampView();
  screenEl.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.s + ')';
  cursorEl.style.left = (cursor.x * 100) + '%';
  cursorEl.style.top = (cursor.y * 100) + '%';
  cursorEl.style.transform = 'scale(' + (1 / view.s) + ')';
  const tag = $('zoomTag');
  tag.style.display = view.s > 1.02 ? 'block' : 'none';
  tag.textContent = view.s.toFixed(1) + 'x';
}

function zoomAt(newScale, lx, ly) {
  const s0 = view.s, s1 = Math.min(MAX_ZOOM, Math.max(1, newScale));
  view.tx = lx - view.base.x - (lx - view.base.x - view.tx) * (s1 / s0);
  view.ty = ly - view.base.y - (ly - view.base.y - view.ty) * (s1 / s0);
  view.s = s1;
  applyView();
}

function resetZoom() { view.s = 1; view.tx = 0; view.ty = 0; layout(); }

// Finger position on the phone -> 0..1 position on the PC screen
function toPc(cx, cy) {
  const r = stage.getBoundingClientRect();
  const x = (cx - r.left - view.base.x - view.tx) / (view.base.w * view.s);
  const y = (cy - r.top - view.base.y - view.ty) / (view.base.h * view.s);
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

// When zoomed in, follow the cursor so it never leaves the phone screen
function canPan() {
  return view.base.w * view.s > stage.clientWidth + 1 || view.base.h * view.s > stage.clientHeight + 1;
}

function keepCursorVisible() {
  if (!canPan()) return;
  const W = stage.clientWidth, H = stage.clientHeight, m = 48;
  const px = view.base.x + view.tx + cursor.x * view.base.w * view.s;
  const py = view.base.y + view.ty + cursor.y * view.base.h * view.s;
  if (px < m) view.tx += m - px; else if (px > W - m) view.tx -= px - (W - m);
  if (py < m) view.ty += m - py; else if (py > H - m) view.ty -= py - (H - m);
  applyView();
}

let pendingMove = false;
function sendCursor() {
  if (pendingMove) return;
  pendingMove = true;
  requestAnimationFrame(() => { pendingMove = false; send({ t: 'move', x: cursor.x, y: cursor.y }); });
}
function at() { return { x: cursor.x, y: cursor.y }; }

video.addEventListener('loadedmetadata', layout);
video.addEventListener('resize', layout);
window.addEventListener('resize', () => { if ($('view').style.display === 'flex') layout(); });

// ---------- finger gestures on the picture ----------
const SENS = 1.6;            // touchpad speed
const HOLD_MS = 450;
const g = { one: null, two: null, lastTwoEnd: 0 };
const ov = $('overlay');

function local(t) { const r = stage.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }

ov.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const ts = e.targetTouches;
  if (ts.length >= 2) {
    if (g.one) { clearTimeout(g.one.timer); if (g.one.dragging) send({ t: 'up', b: 'left', ...g.one.pos }); g.one = null; }
    const a = local(ts[0]), b = local(ts[1]);
    g.two = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: view.s, tx0: view.tx, ty0: view.ty, kind: null, t0: Date.now(), wheel: 0 };
    return;
  }
  if (g.two) return;
  const t = ts[0];
  const one = { sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, t0: Date.now(), moved: false, dragging: false, held: false };
  if (prefs.control === 'touch') {
    one.pos = toPc(t.clientX, t.clientY);
    cursor.x = one.pos.x; cursor.y = one.pos.y; applyView();
    one.timer = setTimeout(() => { one.held = true; buzz(25); send({ t: 'click', b: 'right', ...one.pos }); toast('Right click'); }, 550);
  } else {
    one.pos = at();
    one.timer = setTimeout(() => { one.dragging = true; buzz(25); send({ t: 'down', b: 'left', ...at() }); toast('Drag'); }, HOLD_MS);
  }
  g.one = one;
}, { passive: false });

ov.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const ts = e.targetTouches;
  if (g.two && ts.length >= 2) {
    const a = local(ts[0]), b = local(ts[1]);
    const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const two = g.two, ratio = d / two.d0, dx = m.x - two.m0.x, dy = m.y - two.m0.y;
    if (!two.kind) {
      if (Math.abs(ratio - 1) > 0.08) two.kind = 'zoom';
      else if (Math.hypot(dx, dy) > 12) two.kind = canPan() && Math.abs(dx) > Math.abs(dy) ? 'pan' : (view.s > 1.01 ? 'pan' : 'scroll');
    }
    if (two.kind === 'zoom') {
      view.s = two.s0; view.tx = two.tx0 + dx; view.ty = two.ty0 + dy;
      zoomAt(two.s0 * ratio, m.x, m.y);
    } else if (two.kind === 'pan') {
      view.tx = two.tx0 + dx; view.ty = two.ty0 + dy; applyView();
    } else if (two.kind === 'scroll') {
      const steps = Math.trunc((dy - two.wheel * 36) / 36);
      if (steps) { send({ t: 'wheel', d: steps }); two.wheel += steps; }
    }
    return;
  }
  const one = g.one;
  if (!one || ts.length !== 1) return;
  const t = ts[0];
  if (!one.moved && Math.hypot(t.clientX - one.sx, t.clientY - one.sy) > 8) {
    one.moved = true;
    if (prefs.control === 'touch' && !one.held) { clearTimeout(one.timer); one.dragging = true; send({ t: 'down', b: 'left', ...one.pos }); }
    if (prefs.control === 'mouse' && !one.dragging) clearTimeout(one.timer);
  }
  if (prefs.control === 'touch') {
    if (one.dragging) { one.pos = toPc(t.clientX, t.clientY); cursor.x = one.pos.x; cursor.y = one.pos.y; applyView(); sendCursor(); }
  } else {
    const ddx = (t.clientX - one.lx) * SENS / (view.base.w * view.s);
    const ddy = (t.clientY - one.ly) * SENS / (view.base.h * view.s);
    cursor.x = Math.min(1, Math.max(0, cursor.x + ddx));
    cursor.y = Math.min(1, Math.max(0, cursor.y + ddy));
    one.pos = at();
    applyView(); keepCursorVisible(); sendCursor();
  }
  one.lx = t.clientX; one.ly = t.clientY;
}, { passive: false });

function touchEnd(e) {
  e.preventDefault();
  const left = e.targetTouches.length;
  if (g.two) {
    if (left === 0) {
      const two = g.two;
      if (!two.kind && Date.now() - two.t0 < 300) {   // two-finger tap = right click
        const pos = prefs.control === 'touch' ? toPc(stage.getBoundingClientRect().left + two.m0.x, stage.getBoundingClientRect().top + two.m0.y) : at();
        send({ t: 'click', b: 'right', ...pos }); buzz(20); toast('Right click');
      }
      g.two = null;
    }
    return;
  }
  const one = g.one;
  if (!one || left > 0) return;
  clearTimeout(one.timer);
  if (one.dragging) send({ t: 'up', b: 'left', ...one.pos });
  else if (!one.moved && !one.held && Date.now() - one.t0 < 400) send({ t: 'click', b: 'left', ...one.pos });
  g.one = null;
}
ov.addEventListener('touchend', touchEnd, { passive: false });
ov.addEventListener('touchcancel', touchEnd, { passive: false });

// Mouse and wheel (when testing from a computer browser)
ov.addEventListener('mousedown', (e) => { const p = toPc(e.clientX, e.clientY); cursor.x = p.x; cursor.y = p.y; applyView(); send({ t: 'down', b: e.button === 2 ? 'right' : 'left', ...p }); });
ov.addEventListener('mousemove', (e) => { if (e.buttons) { const p = toPc(e.clientX, e.clientY); cursor.x = p.x; cursor.y = p.y; applyView(); sendCursor(); } });
ov.addEventListener('mouseup', (e) => send({ t: 'up', b: e.button === 2 ? 'right' : 'left', ...toPc(e.clientX, e.clientY) }));
ov.addEventListener('contextmenu', (e) => e.preventDefault());
ov.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) { const l = local(e); zoomAt(view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), l.x, l.y); }
  else send({ t: 'wheel', d: e.deltaY > 0 ? -1 : 1 });
}, { passive: false });

// ---------- the floating mouse pad ----------
const pad = $('pad');
function placePad() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const pw = pad.offsetWidth || 190, ph = pad.offsetHeight || 140;
  const p = prefs.pad || { x: (W - pw) / 2 / W, y: (H - ph - 24) / H };
  pad.style.left = Math.min(W - pw, Math.max(0, p.x * W)) + 'px';
  pad.style.top = Math.min(H - ph, Math.max(0, p.y * H)) + 'px';
}
window.addEventListener('resize', placePad);

function holdButton(el, b) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    el.classList.add('down'); buzz(12); send({ t: 'down', b, ...at() });
  });
  const up = (e) => { if (!el.classList.contains('down')) return; el.classList.remove('down'); send({ t: 'up', b, ...at() }); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
holdButton($('padL'), 'left');
holdButton($('padR'), 'right');

(() => {
  const wheel = $('padWheel');
  let y0 = null, sent = 0;
  wheel.addEventListener('pointerdown', (e) => { e.preventDefault(); wheel.setPointerCapture(e.pointerId); y0 = e.clientY; sent = 0; });
  wheel.addEventListener('pointermove', (e) => {
    if (y0 === null) return;
    const steps = Math.trunc((y0 - e.clientY) / 16) - sent;
    if (steps) { send({ t: 'wheel', d: steps }); sent += steps; buzz(5); }
  });
  const end = () => { y0 = null; };
  wheel.addEventListener('pointerup', end);
  wheel.addEventListener('pointercancel', end);

  const grip = $('padMove');
  let start = null;
  grip.addEventListener('pointerdown', (e) => { e.preventDefault(); grip.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY, l: pad.offsetLeft, t: pad.offsetTop }; });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    const l = Math.min(W - pad.offsetWidth, Math.max(0, start.l + e.clientX - start.x));
    const t = Math.min(H - pad.offsetHeight, Math.max(0, start.t + e.clientY - start.y));
    pad.style.left = l + 'px'; pad.style.top = t + 'px';
  });
  const done = () => { if (!start) return; start = null; prefs.pad = { x: pad.offsetLeft / stage.clientWidth, y: pad.offsetTop / stage.clientHeight }; savePrefs(); };
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', done);
})();

// ---------- keyboard ----------
const kb = $('kb');
const SENTINEL = ' ';
function resetKb() { kb.value = SENTINEL; try { kb.setSelectionRange(1, 1); } catch (e) {} }
$('kbBtn').onclick = () => { resetKb(); kb.focus(); };
kb.addEventListener('input', () => {
  const v = kb.value;
  if (v.length < SENTINEL.length) send({ t: 'key', k: 'Backspace' });
  else if (v.length > SENTINEL.length) send({ t: 'text', s: v.slice(SENTINEL.length) });
  resetKb();
});
kb.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send({ t: 'key', k: 'Enter' }); } });

// ---------- side buttons and menu ----------
function setControl(c) {
  prefs.control = c; savePrefs();
  $('view').classList.toggle('mouse', c === 'mouse');
  $('modeBtn').classList.toggle('on', c === 'mouse');
  markMenu();
  requestAnimationFrame(placePad);
}
function markMenu() {
  document.querySelectorAll('#menu [data-control]').forEach((b) => b.classList.toggle('on', b.dataset.control === prefs.control));
  document.querySelectorAll('#menu [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === prefs.view));
  document.querySelectorAll('#menu [data-quality]').forEach((b) => b.classList.toggle('on', b.dataset.quality === quality));
  document.querySelectorAll('#menu [data-rotate]').forEach((b) => b.classList.toggle('on', b.dataset.rotate === prefs.rotate));
}
async function setRotate(r) {
  prefs.rotate = r; savePrefs(); markMenu();
  try {
    if (r === 'any') { screen.orientation.unlock(); return; }
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    await screen.orientation.lock(r);
  } catch (e) { toast('Turn your phone to rotate'); }
}

$('modeBtn').onclick = () => { setControl(prefs.control === 'mouse' ? 'touch' : 'mouse'); toast(prefs.control === 'mouse' ? 'Mouse mode: move the pointer like a touchpad' : 'Touch mode: tap where you want to click'); };
$('fitBtn').onclick = () => { resetZoom(); toast('Zoom reset'); };
$('hideBtn').onclick = () => { const c = $('view').classList.toggle('clean'); $('hideBtn').classList.toggle('on', c); };
$('menuBtn').onclick = () => { markMenu(); $('menu').classList.toggle('open'); };
$('closeMenu').onclick = () => $('menu').classList.remove('open');
document.querySelectorAll('#menu [data-control]').forEach((b) => { b.onclick = () => setControl(b.dataset.control); });
document.querySelectorAll('#menu [data-view]').forEach((b) => { b.onclick = () => { prefs.view = b.dataset.view; savePrefs(); resetZoom(); markMenu(); }; });
document.querySelectorAll('#menu [data-quality]').forEach((b) => { b.onclick = () => { quality = prefs.quality = b.dataset.quality; savePrefs(); sendQuality(); markMenu(); toast('Quality: ' + QUALITY_LABEL[quality]); }; });
document.querySelectorAll('#menu [data-rotate]').forEach((b) => { b.onclick = () => setRotate(b.dataset.rotate); });
document.querySelectorAll('#menu [data-key]').forEach((b) => { b.onclick = () => send({ t: 'key', k: b.dataset.key }); });
document.querySelectorAll('#menu [data-combo]').forEach((b) => { b.onclick = () => send({ t: 'combo', keys: b.dataset.combo.split(',') }); });
$('fsBtn').onclick = () => { const el = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => toast('Full screen not available here')); };
$('endBtn').onclick = () => { $('menu').classList.remove('open'); endView(); };

function enterView() {
  show('view');
  setControl(prefs.control);
  resetZoom();
  placePad();
  if (prefs.rotate !== 'any') setRotate(prefs.rotate);
  video.play().catch(() => {});
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
renderPcs();
