/* Relay client + WebRTC session. Video and control travel peer-to-peer;
 * the relay only forwards the handshake. */
(function () {
  'use strict';

  const PING_MS = 20_000;

  class Relay {
    constructor(url, handlers) {
      this.url = url;
      this.h = handlers || {};
      this.ws = null;
      this.closedByUs = false;
      this.retry = 0;
      this.timer = null;
      this.pingTimer = null;
    }

    connect() {
      return new Promise((resolve, reject) => {
        let settled = false;
        let ws;
        try {
          ws = new WebSocket(this.url);
        } catch (err) {
          reject(new Error(`Bad relay address: ${this.url}`));
          return;
        }
        this.ws = ws;

        const fail = (err) => {
          if (!settled) { settled = true; reject(err); }
        };

        ws.onopen = () => {
          settled = true;
          this.retry = 0;
          this.startPing();
          if (this.h.onOpen) this.h.onOpen();
          resolve();
        };

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (!msg || !msg.type) return;
          if (msg.type === 'pong') return;
          if (this.h.onMessage) this.h.onMessage(msg);
        };

        ws.onerror = () => {
          fail(new Error('Could not reach the relay server.'));
        };

        ws.onclose = () => {
          this.stopPing();
          fail(new Error('Relay connection closed.'));
          if (this.h.onClose) this.h.onClose(this.closedByUs);
          if (!this.closedByUs) this.scheduleReconnect();
        };
      });
    }

    scheduleReconnect() {
      clearTimeout(this.timer);
      const wait = Math.min(1000 * 2 ** this.retry, 10_000);
      this.retry += 1;
      this.timer = setTimeout(() => {
        this.connect().catch(() => { /* onclose schedules the next try */ });
      }, wait);
    }

    startPing() {
      this.stopPing();
      this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), PING_MS);
    }

    stopPing() {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    get isOpen() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    send(msg) {
      if (!this.isOpen) return false;
      try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    }

    close() {
      this.closedByUs = true;
      clearTimeout(this.timer);
      this.stopPing();
      try { this.ws && this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /* ------------------------------------------------------------------ */

  function buildIceServers(turn) {
    const servers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    // turn value looks like: turn:host:3478|username|password
    if (turn && typeof turn === 'string' && turn.includes('|')) {
      const [urls, username, credential] = turn.split('|');
      if (urls && username && credential) {
        servers.push({
          urls: urls.split(',').map((s) => s.trim()).filter(Boolean),
          username: username.trim(),
          credential: credential.trim(),
        });
      }
    }
    return servers;
  }

  class RtcSession {
    /**
     * @param {object} opts
     * @param {Relay}  opts.relay
     * @param {'host'|'viewer'} opts.role
     * @param {string} [opts.turn]
     * @param {(stream: MediaStream) => void} opts.onStream
     * @param {(state: string) => void} opts.onState
     * @param {(msg: object) => void} opts.onData
     * @param {(channel: RTCDataChannel) => void} [opts.onChannel]
     */
    constructor(opts) {
      this.relay = opts.relay;
      this.role = opts.role;
      this.iceServers = buildIceServers(opts.turn);
      this.onStream = opts.onStream || (() => {});
      this.onState = opts.onState || (() => {});
      this.onData = opts.onData || (() => {});
      this.onChannel = opts.onChannel || (() => {});
      this.pc = null;
      this.dc = null;
      this.pendingIce = [];
      this.closed = false;
    }

    _newPc() {
      if (this.pc) { try { this.pc.close(); } catch { /* ignore */ } }
      const pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
      });
      this.pc = pc;

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.relay.send({ type: 'ice', candidate: ev.candidate.toJSON() });
        }
      };

      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (stream) this.onStream(stream);
      };

      pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const st = this.pc.connectionState;
        this.onState(st);
        if (st === 'failed') this.restartIce();
      };

      pc.oniceconnectionstatechange = () => {
        if (this.pc && this.pc.iceConnectionState === 'failed') this.restartIce();
      };

      if (this.role === 'viewer') {
        pc.ondatachannel = (ev) => {
          this.bindChannel(ev.channel);
        };
      }
      return pc;
    }

    async restartIce() {
      if (this.closed || !this.pc) return;
      try {
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        this.relay.send({ type: 'offer', sdp: this.pc.localDescription });
      } catch { /* ignore */ }
    }

    bindChannel(channel) {
      this.dc = channel;
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => this.onChannel(channel);
      channel.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && msg.k) this.onData(msg);
      };
      if (channel.readyState === 'open') this.onChannel(channel);
    }

    get dataOpen() {
      return Boolean(this.dc && this.dc.readyState === 'open');
    }

    sendData(msg) {
      if (!this.dataOpen) return false;
      try { this.dc.send(JSON.stringify(msg)); return true; } catch { return false; }
    }

    /** HOST: attach the local screen stream and send an offer. */
    async share(stream, hints) {
      const pc = this._newPc();
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === 'video') {
          try {
            const params = sender.getParameters();
            params.degradationPreference = hints && hints.sharp ? 'maintain-resolution' : 'maintain-framerate';
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = (hints && hints.maxBitrate) || 8_000_000;
            params.encodings[0].maxFramerate = (hints && hints.maxFramerate) || 30;
            await sender.setParameters(params);
          } catch { /* not all platforms accept these */ }
        }
      }
      this.bindChannel(pc.createDataChannel('screenlink', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.relay.send({ type: 'offer', sdp: pc.localDescription });
    }

    /** VIEWER: answer an incoming offer (also used for ICE restarts). */
    async answer(sdp) {
      const pc = this.pc || this._newPc();
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushIce();
      const local = await pc.createAnswer();
      await pc.setLocalDescription(local);
      this.relay.send({ type: 'answer', sdp: pc.localDescription });
    }

    /** HOST: consume the viewer's answer. */
    async acceptAnswer(sdp) {
      if (!this.pc) return;
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await this.flushIce();
      } catch { /* ignore late answers */ }
    }

    async addIce(candidate) {
      if (!candidate) return;
      if (!this.pc || !this.pc.remoteDescription) {
        this.pendingIce.push(candidate);
        return;
      }
      try { await this.pc.addIceCandidate(candidate); } catch { /* ignore */ }
    }

    async flushIce() {
      const queue = this.pendingIce.splice(0);
      for (const c of queue) {
        try { await this.pc.addIceCandidate(c); } catch { /* ignore */ }
      }
    }

    async stats() {
      if (!this.pc) return null;
      try {
        const report = await this.pc.getStats();
        let out = { bitrate: 0, fps: 0, width: 0, height: 0 };
        let bytes = 0;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            bytes = s.bytesReceived || s.bytesSent || 0;
            out.fps = Math.round(s.framesPerSecond || 0);
            out.width = s.frameWidth || 0;
            out.height = s.frameHeight || 0;
          }
          if (s.type === 'outbound-rtp' && s.kind === 'video') {
            bytes = s.bytesSent || 0;
            out.fps = Math.round(s.framesPerSecond || 0);
            out.width = s.frameWidth || 0;
            out.height = s.frameHeight || 0;
          }
        });
        const now = performance.now();
        if (this._lastBytes != null && this._lastAt != null) {
          const dt = (now - this._lastAt) / 1000;
          if (dt > 0.2) out.bitrate = Math.max(0, Math.round(((bytes - this._lastBytes) * 8) / dt / 1000));
        }
        this._lastBytes = bytes;
        this._lastAt = now;
        return out;
      } catch {
        return null;
      }
    }

    close() {
      this.closed = true;
      try { this.dc && this.dc.close(); } catch { /* ignore */ }
      try { this.pc && this.pc.close(); } catch { /* ignore */ }
      this.dc = null;
      this.pc = null;
    }
  }

  /* ------------------------------------------------------------------ */

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    if (window.crypto && window.crypto.subtle) {
      const buf = await window.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return text; // non-secure context fallback (lan demo only)
  }

  function randomDigits(len) {
    const out = [];
    const bytes = new Uint32Array(len);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < len; i += 1) out.push(bytes[i] % 10);
    if (out[0] === 0) out[0] = 1;
    return out.join('');
  }

  function randomPassword(len) {
    // unambiguous alphabet: no 0/O, 1/l/I
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(len);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  function formatId(id) {
    return String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  }

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 9);
  }

  window.Net = { Relay, RtcSession, sha256, randomDigits, randomPassword, formatId, digitsOnly };
})();
