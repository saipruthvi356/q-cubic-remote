// Q-CUBIC Remote - phone app logic
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

const N = window.QCRNet;
const $ = (id) => document.getElementById(id);
const STORE = 'qcr.pcs.v1';
const QUALITIES = ['fast', 'balanced', 'sharp'];
const QUALITY_LABEL = { fast: 'Fast', balanced: 'Balanced', sharp: 'Sharp' };

// For local testing only: allow a relay override when the page runs on this computer.
const brokers = (() => {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const p = new URLSearchParams(location.search).get('relay');
  return isLocal && p ? p.split(',') : N.BROKERS;
})();

let relays = [], pc = null, channel = null, rightNext = false;
let quality = 'fast';
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
    if (s === 'connected') { closeRelays(); msgEl.textContent = ''; show('view'); $('video').play().catch(() => {}); }
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

// ---------- controls ----------
function toast(text) {
  const t = $('toast'); t.textContent = text; t.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 2000);
}
function send(ev) { if (channel && channel.readyState === 'open') channel.send(JSON.stringify(ev)); }
function sendQuality() { send({ t: 'quality', v: quality }); $('qBtn').textContent = QUALITY_LABEL[quality]; }

function toScreen(clientX, clientY) {
  const v = $('video'), r = $('stage').getBoundingClientRect();
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
  return { x: Math.min(1, Math.max(0, (clientX - left) / w)), y: Math.min(1, Math.max(0, (clientY - top) / h)) };
}

// Send drag moves at most once per screen frame.
let pendingMove = null;
function queueMove(pos) {
  if (!pendingMove) requestAnimationFrame(() => { if (pendingMove) send({ t: 'move', ...pendingMove }); pendingMove = null; });
  pendingMove = pos;
}

const g = { start: null, last: null, dragging: false, held: false, timer: null, scrollY: null, multi: false };
const ov = $('overlay');
ov.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length >= 2) {
    clearTimeout(g.timer); g.multi = true;
    if (g.dragging) { send({ t: 'up', b: 'left', ...g.last }); g.dragging = false; }
    g.scrollY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    return;
  }
  const t = e.touches[0];
  g.start = { cx: t.clientX, cy: t.clientY }; g.last = toScreen(t.clientX, t.clientY);
  g.dragging = false; g.held = false; g.multi = false;
  g.timer = setTimeout(() => { g.held = true; send({ t: 'click', b: 'right', ...g.last }); toast('Right click'); }, 550);
}, { passive: false });

ov.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length >= 2 && g.scrollY !== null) {
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const steps = Math.trunc((g.scrollY - y) / 40);
    if (steps) { send({ t: 'wheel', d: -steps }); g.scrollY -= steps * 40; }
    return;
  }
  if (g.multi || g.held || !g.start) return;
  const t = e.touches[0];
  if (!g.dragging && Math.hypot(t.clientX - g.start.cx, t.clientY - g.start.cy) > 12) {
    clearTimeout(g.timer); g.dragging = true; send({ t: 'down', b: 'left', ...g.last });
  }
  if (g.dragging) { g.last = toScreen(t.clientX, t.clientY); queueMove(g.last); }
}, { passive: false });

ov.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (e.touches.length > 0) return;
  clearTimeout(g.timer);
  if (g.multi) { g.multi = false; g.scrollY = null; return; }
  if (g.held || !g.start) return;
  if (g.dragging) send({ t: 'up', b: 'left', ...g.last });
  else { send({ t: 'click', b: rightNext ? 'right' : 'left', ...g.last }); if (rightNext) { rightNext = false; $('rcBtn').classList.remove('on'); } }
  g.start = null; g.dragging = false;
}, { passive: false });

ov.addEventListener('mousedown', (e) => send({ t: 'down', b: e.button === 2 ? 'right' : 'left', ...toScreen(e.clientX, e.clientY) }));
ov.addEventListener('mousemove', (e) => { if (e.buttons) queueMove(toScreen(e.clientX, e.clientY)); });
ov.addEventListener('mouseup', (e) => send({ t: 'up', b: e.button === 2 ? 'right' : 'left', ...toScreen(e.clientX, e.clientY) }));
ov.addEventListener('contextmenu', (e) => e.preventDefault());
ov.addEventListener('wheel', (e) => { e.preventDefault(); send({ t: 'wheel', d: e.deltaY > 0 ? -1 : 1 }); }, { passive: false });

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

$('rcBtn').onclick = () => { rightNext = !rightNext; $('rcBtn').classList.toggle('on', rightNext); if (rightNext) toast('Next tap is a right click'); };
$('qBtn').onclick = () => { quality = QUALITIES[(QUALITIES.indexOf(quality) + 1) % QUALITIES.length]; sendQuality(); toast('Quality: ' + QUALITY_LABEL[quality]); };
document.querySelectorAll('#bar [data-key]').forEach((b) => { b.onclick = () => send({ t: 'key', k: b.dataset.key }); });
$('fsBtn').onclick = () => { const el = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => {}); };
$('endBtn').onclick = () => endView();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
renderPcs();
