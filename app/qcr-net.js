// Q-CUBIC Remote - shared networking: tiny MQTT client + end-to-end encryption.
// Used by both the PC app and the phone app.
// Copyright (c) 2026 Pruthvi. All rights reserved.
//
// How "connect from anywhere" works:
// - Both sides meet on a free public message relay (MQTT over secure WebSocket).
// - Every message is sealed with AES-256-GCM before it leaves the device, so the
//   relay only ever sees random-looking bytes. It never sees the screen either:
//   the screen goes directly phone <-> PC over WebRTC (encrypted with DTLS-SRTP).
(function (root) {
  'use strict';

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = root.crypto.subtle;

  // ---------- small helpers ----------
  function b64(bytes) {
    let s = '';
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function hex(bytes) {
    return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randomBytes(n) {
    const u = new Uint8Array(n);
    root.crypto.getRandomValues(u);
    return u;
  }
  function randomDigits(n) {
    const u = randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String(u[i] % 10);
    return s;
  }
  async function sha256(text) {
    return new Uint8Array(await subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text));
  }
  function cleanId(id) { return String(id || '').replace(/\D/g, ''); }

  // ---------- keys ----------
  // First-time pairing: key from the device ID + the short code shown on the PC.
  async function pairKey(deviceId, code) {
    const base = await subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('qcr-pair-v1:' + cleanId(deviceId)), iterations: 150000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // After pairing: a long random secret that only the PC and that phone know.
  async function trustKey(secretB64) {
    return subtle.importKey('raw', unb64(secretB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function keyId(secretB64) {
    return hex(await sha256(unb64(secretB64))).slice(0, 16);
  }
  function newSecret() { return b64(randomBytes(32)); }

  async function seal(key, obj) {
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function open(key, env) {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return JSON.parse(dec.decode(pt));
  }

  async function topics(deviceId) {
    const h = hex(await sha256('qcr-topic-v1:' + cleanId(deviceId))).slice(0, 32);
    return { inbox: 'qcr1/' + h + '/in', outbox: (sid) => 'qcr1/' + h + '/out/' + sid };
  }

  // ---------- tiny MQTT 3.1.1 client over WebSocket (QoS 0 only) ----------
  function encodeLength(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }
  function mqttString(s) {
    const b = enc.encode(s);
    return [b.length >> 8, b.length & 0xff, ...b];
  }
  function packet(type, body) {
    const u = new Uint8Array(1 + encodeLength(body.length).length + body.length);
    const len = encodeLength(body.length);
    u[0] = type;
    u.set(len, 1);
    u.set(body, 1 + len.length);
    return u;
  }

  class Relay {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.handlers = [];
      this.subs = new Set();
      this.buf = new Uint8Array(0);
      this.packetId = 1;
      this.ready = false;
      this.closed = false;
      this.ping = null;
    }
    onMessage(fn) { this.handlers.push(fn); }
    connect(timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        let done = false;
        const fail = (e) => { if (!done) { done = true; reject(e); } };
        const timer = setTimeout(() => { fail(new Error('relay timeout')); try { this.ws.close(); } catch (x) {} }, timeoutMs);
        let ws;
        try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { clearTimeout(timer); return fail(e); }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          const clientId = 'qcr-' + hex(randomBytes(8));
          const body = [...mqttString('MQTT'), 4, 0x02, 0, 60, ...mqttString(clientId)];
          ws.send(packet(0x10, body));
        };
        ws.onerror = () => { clearTimeout(timer); fail(new Error('relay unreachable')); };
        ws.onclose = () => {
          this.ready = false;
          clearInterval(this.ping);
          clearTimeout(timer);
          fail(new Error('relay closed'));
          if (!this.closed && this.onclose) this.onclose();
        };
        ws.onmessage = (ev) => {
          const chunk = new Uint8Array(ev.data);
          const merged = new Uint8Array(this.buf.length + chunk.length);
          merged.set(this.buf); merged.set(chunk, this.buf.length);
          this.buf = merged;
          this._drain((type) => {
            if (type === 0x20 && !done) {
              done = true; clearTimeout(timer); this.ready = true;
              this.ping = setInterval(() => { try { ws.send(new Uint8Array([0xc0, 0])); } catch (e) {} }, 30000);
              for (const t of this.subs) this._sendSubscribe(t);
              resolve(this);
            }
          });
        };
      });
    }
    _drain(onControl) {
      for (;;) {
        if (this.buf.length < 2) return;
        let mult = 1, len = 0, i = 1, b;
        do {
          if (i >= this.buf.length) return;
          b = this.buf[i++];
          len += (b & 0x7f) * mult;
          mult *= 128;
        } while (b & 0x80);
        if (this.buf.length < i + len) return;
        const header = this.buf[0];
        const type = header & 0xf0;
        const body = this.buf.slice(i, i + len);
        this.buf = this.buf.slice(i + len);
        if (type === 0x30) {
          const tlen = (body[0] << 8) | body[1];
          const topic = dec.decode(body.slice(2, 2 + tlen));
          const qos = (header >> 1) & 0x03; // QoS 1/2 messages carry a 2-byte packet id
          const payload = dec.decode(body.slice(2 + tlen + (qos ? 2 : 0)));
          for (const h of this.handlers) { try { h(topic, payload, this); } catch (e) {} }
        } else {
          onControl(type);
        }
      }
    }
    _sendSubscribe(topic) {
      const id = this.packetId++ & 0xffff || 1;
      this.ws.send(packet(0x82, [id >> 8, id & 0xff, ...mqttString(topic), 0]));
    }
    subscribe(topic) {
      this.subs.add(topic);
      if (this.ready) this._sendSubscribe(topic);
    }
    publish(topic, text) {
      if (!this.ready) return false;
      this.ws.send(packet(0x30, [...mqttString(topic), ...enc.encode(text)]));
      return true;
    }
    close() {
      this.closed = true;
      clearInterval(this.ping);
      try { this.ws.send(new Uint8Array([0xe0, 0])); } catch (e) {}
      try { this.ws.close(); } catch (e) {}
    }
  }

  function waitForIce(pc, ms) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  root.QCRNet = {
    BROKERS, ICE_SERVERS, Relay, pairKey, trustKey, keyId, newSecret, seal, open, topics,
    randomDigits, hex, randomBytes, cleanId, waitForIce,
  };
})(typeof window !== 'undefined' ? window : globalThis);
