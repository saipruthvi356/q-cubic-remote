// Q-CUBIC Remote - host window: meets the phone on the relay, then streams the screen directly.
// Copyright (c) 2026 Pruthvi. All rights reserved.
'use strict';

const N = window.QCRNet;
const $ = (id) => document.getElementById(id);

// fast = Smooth, balanced = HD (default), sharp = Ultra
const QUALITY = {
  fast:     { maxWidth: 1280, fps: 60, bitrate: 4000000,  pref: 'maintain-framerate',  hint: 'motion' },
  balanced: { maxWidth: 1920, fps: 30, bitrate: 8000000,  pref: 'balanced',            hint: 'detail' },
  sharp:    { maxWidth: 2560, fps: 30, bitrate: 16000000, pref: 'maintain-resolution', hint: 'text' },
};
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;

let info = null;
let topics = null;
let trusted = new Map();      // kid -> { key, secret, name }
let code = null, codeKey = null, codeExpires = 0, fails = 0;
let session = null;           // { sid, key, relay, pc, stream, sender, track, pairing, phoneName }

function log(t) { if (info && info.debug) window.qcr.log(t); }
function setStatus(text, on) { $('status').textContent = text; $('dot').classList.toggle('on', !!on); }

async function newCode() {
  code = N.randomDigits(6);
  codeExpires = Date.now() + CODE_LIFETIME_MS;
  fails = 0;
  $('code').textContent = code;
  codeKey = await N.pairKey(info.deviceId, code);
  log('[pair-code] ' + code);
}

async function loadTrusted(list) {
  trusted = new Map();
  for (const t of list) trusted.set(t.kid, { key: await N.trustKey(t.secret), secret: t.secret, name: t.name });
  $('phones').textContent = list.length ? list.map((t) => t.name).join(', ') : 'None yet';
}

function stopSession() {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
  session = null;
}

async function applyQuality(name) {
  if (!session || !session.sender) return;
  const q = QUALITY[name] || QUALITY.balanced;
  try { session.track.contentHint = q.hint; } catch (e) {}
  const s = session.track.getSettings();
  const scale = s.width && s.width > q.maxWidth ? s.width / q.maxWidth : 1;
  try {
    const p = session.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = q.bitrate;
    p.encodings[0].maxFramerate = q.fps;
    p.encodings[0].scaleResolutionDownBy = scale;
    p.degradationPreference = q.pref;
    await session.sender.setParameters(p);
    log('quality ' + name + ' scale ' + scale.toFixed(2));
  } catch (e) { log('quality error ' + e.message); }
}

function preferH264(transceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
    const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
    if (h264.length) transceiver.setCodecPreferences([...h264, ...rest]);
  } catch (e) {}
}

async function send(relay, sid, key, obj) {
  const env = await N.seal(key, obj);
  relay.publish(topics.outbox(sid), JSON.stringify(env));
}

async function startSession(sid, key, relay, hello, pairing) {
  stopSession();
  const s = { sid, key, relay, pairing, phoneName: String(hello.name || 'Phone').slice(0, 40) };
  session = s;
  setStatus('Phone found. Starting screen...', true);
  try {
    s.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false });
  } catch (e) { setStatus('Could not capture the screen: ' + e.message, false); session = null; return; }
  s.track = s.stream.getVideoTracks()[0];
  s.track.contentHint = 'detail';

  const pc = new RTCPeerConnection({ iceServers: N.ICE_SERVERS });
  s.pc = pc;
  const tr = pc.addTransceiver(s.track, { direction: 'sendonly', streams: [s.stream] });
  s.sender = tr.sender;
  preferH264(tr);

  const ch = pc.createDataChannel('input', { ordered: true });
  ch.onopen = async () => {
    if (!s.pairing) return;
    const secret = N.newSecret();
    const kid = await N.keyId(secret);
    ch.send(JSON.stringify({ t: 'trust', secret, deviceId: info.deviceId, name: info.hostName }));
    await window.qcr.addTrusted({ kid, secret, name: s.phoneName });
    const fresh = await window.qcr.info();
    await loadTrusted(fresh.trusted);
    await newCode();            // a code works only once
  };
  ch.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
    if (ev.t === 'quality') { s.quality = ev.v; applyQuality(ev.v); return; }
    window.qcr.sendInput(ev);
  };

  pc.onconnectionstatechange = () => {
    if (session !== s) return;
    const st = pc.connectionState;
    if (st === 'connected') { setStatus('Connected to ' + s.phoneName + '.', true); applyQuality(s.quality || 'balanced'); }
    if (st === 'failed') { setStatus('Could not connect to the phone on this network.', false); stopSession(); }
    if (st === 'disconnected' || st === 'closed') { setStatus('Phone disconnected. Waiting...', false); }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await N.waitForIce(pc, 3000);
  await send(relay, sid, key, { type: 'offer', sdp: pc.localDescription.sdp, pairing, hostName: info.hostName });
  log('offer sent to ' + sid);
}

async function onRelayMessage(topic, payload, relay) {
  if (topic !== topics.inbox) return;
  let env; try { env = JSON.parse(payload); } catch (e) { return; }
  if (!env || typeof env.sid !== 'string' || !/^[a-f0-9]{16,48}$/.test(env.sid) || !env.iv || !env.ct) return;

  // An answer for the session that is starting
  if (session && session.sid === env.sid) {
    try {
      const msg = await N.open(session.key, env);
      if (msg.type === 'answer' && session.pc && !session.pc.currentRemoteDescription) {
        await session.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        log('answer applied');
      }
    } catch (e) {}
    return;
  }

  // A new phone saying hello
  let key, pairing;
  if (env.kid) {
    const t = trusted.get(String(env.kid));
    if (!t) return;
    key = t.key; pairing = false;
  } else {
    if (Date.now() > codeExpires) await newCode();
    key = codeKey; pairing = true;
  }
  let hello;
  try { hello = await N.open(key, env); }
  catch (e) {
    if (pairing && ++fails >= MAX_FAILS) await newCode();
    return;
  }
  if (hello.type !== 'hello' || Math.abs(Date.now() - Number(hello.ts)) > 2 * 60 * 1000) return;
  startSession(env.sid, key, relay, hello, pairing);
}

const relayByUrl = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep one live connection per relay, reconnecting after drops.
async function relayLoop(url) {
  let attempt = 0;
  for (;;) {
    const r = new N.Relay(url);
    r.onMessage(onRelayMessage);
    r.subscribe(topics.inbox);
    const closed = new Promise((res) => { r.onclose = res; });
    try {
      await r.connect();
      attempt = 0;
      relayByUrl[url] = r;
      updateRelayText();
      log('relay ok ' + url);
      await closed;
    } catch (e) {
      log('relay fail ' + url + ' ' + e.message);
    }
    relayByUrl[url] = null;
    updateRelayText();
    await sleep(Math.min(30000, 2000 * ++attempt));
  }
}

function updateRelayText() {
  const live = Object.values(relayByUrl).filter((r) => r && r.ready).length;
  $('relay').textContent = live ? 'Online: ready for your phone from any network.' : 'Offline: check this PC’s internet.';
  if (!session) setStatus(live ? 'Waiting for your phone...' : 'Not online yet...', false);
}

(async () => {
  info = await window.qcr.info();
  const id = info.deviceId;
  $('deviceId').textContent = id.slice(0, 3) + ' ' + id.slice(3, 6) + ' ' + id.slice(6);
  log('[device-id] ' + id);
  topics = await N.topics(id);
  await loadTrusted(info.trusted);
  await newCode();
  $('newCode').onclick = () => newCode();
  $('clearPhones').onclick = async () => { await window.qcr.clearTrusted(); await loadTrusted([]); stopSession(); };
  setInterval(() => { if (Date.now() > codeExpires) newCode(); updateRelayText(); }, 15000);
  for (const url of (info.brokers || N.BROKERS)) relayLoop(url);
})();
