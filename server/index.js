/**
 * ScreenLink relay server.
 *
 * Tiny, dependency-light WebSocket relay. It does NOT see your screen or your
 * input: it only introduces two peers and forwards WebRTC handshake messages.
 * After the handshake, video + control travel directly between the two devices.
 *
 * Run:            node server/index.js
 * Choose a port:  PORT=9000 node server/index.js
 *
 * It also serves the web build in ../src (used by `npm run demo` and by the
 * browser viewer), so one process is enough for a self-hosted setup.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const IDLE_TIMEOUT_MS = 1000 * 60 * 10; // drop dead sockets after 10 min of silence
const MAX_JOIN_FAILS = 5;

/* ------------------------------------------------------------------ */
/* Static file hosting (optional, for the browser viewer / demo)      */
/* ------------------------------------------------------------------ */

const WEB_ROOT = path.join(__dirname, '..', 'src');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(WEB_ROOT, rel);

  // never escape the web root (compare with the separator so a sibling
  // directory such as `src-old` can never pass the prefix test)
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, sessions: rooms.size, uptime: process.uptime() }));
    return;
  }
  serveStatic(req, res);
});

/* ------------------------------------------------------------------ */
/* Relay                                                              */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

/** id -> { host, secret, viewer, hostName, joinFails, blockedUntil, createdAt } */
const rooms = new Map();

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
};

const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
};

function closeRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return;
  rooms.delete(id);
  for (const peer of [room.host, room.viewer]) {
    if (peer && peer.readyState === 1) {
      send(peer, { type: 'closed', reason });
      peer.close();
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.role = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      /* ---------------- host side ---------------- */
      case 'register': {
        const id = String(msg.id || '');
        const secret = String(msg.secret || '');
        if (!/^\d{9}$/.test(id) || secret.length < 16) {
          return send(ws, { type: 'error', code: 'bad_request', message: 'Invalid ID or password hash.' });
        }
        // A viewer must never be able to claim/hijack a room: only hosts
        // register. Without this a joined peer could delete the host's room.
        if (ws.role === 'viewer') {
          return send(ws, { type: 'error', code: 'bad_request', message: 'Leave the session before you start sharing.' });
        }
        if (rooms.has(id)) {
          return send(ws, { type: 'error', code: 'id_taken', message: 'That ID is already in use. Generate a new one.' });
        }
        // one session per socket: drop the previous room this socket hosted
        if (ws.role === 'host' && ws.roomId) {
          const old = rooms.get(ws.roomId);
          if (old && old.host === ws) {
            rooms.delete(ws.roomId);
            if (old.viewer && old.viewer.readyState === 1) {
              send(old.viewer, { type: 'closed', reason: 'host_left' });
              try { old.viewer.close(); } catch { /* ignore */ }
            }
          }
          ws.roomId = null;
        }
        rooms.set(id, {
          host: ws, secret, viewer: null, joinFails: 0, blockedUntil: 0,
          createdAt: Date.now(), hostName: String(msg.name || '').slice(0, 40),
        });
        ws.roomId = id;
        ws.role = 'host';
        send(ws, { type: 'registered', id });
        break;
      }

      case 'unregister':
        if (ws.role === 'host' && ws.roomId) closeRoom(ws.roomId, 'host_left');
        ws.roomId = null;
        ws.role = null;
        break;

      /* ---------------- viewer side ---------------- */
      case 'join': {
        const id = String(msg.id || '');
        const room = rooms.get(id);
        if (!room) {
          return send(ws, { type: 'error', code: 'not_found', message: 'No one is online with that ID.' });
        }
        if (room.blockedUntil > Date.now()) {
          return send(ws, { type: 'error', code: 'too_many', message: 'Too many wrong passwords. Wait a minute and try again.' });
        }
        if (!sameSecret(room.secret, String(msg.secret || ''))) {
          room.joinFails += 1;
          if (room.joinFails >= MAX_JOIN_FAILS) room.blockedUntil = Date.now() + 60_000;
          return send(ws, { type: 'error', code: 'bad_password', message: 'Wrong password.' });
        }
        if (room.viewer && room.viewer.readyState === 1) {
          if (room.viewer === ws) break;
          // bump the old viewer
          send(room.viewer, { type: 'closed', reason: 'replaced' });
          try { room.viewer.close(); } catch { /* ignore */ }
        }
        room.viewer = ws;
        room.joinFails = 0;
        ws.roomId = id;
        ws.role = 'viewer';
        send(ws, { type: 'joined', id, hostName: room.hostName });
        send(room.host, { type: 'peer-joined', name: String(msg.name || 'Friend').slice(0, 40) });
        break;
      }

      /* ---------------- WebRTC handshake pass-through ---------------- */
      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms.get(ws.roomId);
        if (!room) return send(ws, { type: 'error', code: 'not_found', message: 'Session ended.' });
        const target = ws.role === 'host' ? room.viewer : room.host;
        send(target, msg);
        break;
      }

      /* ---------------- control / lifecycle ---------------- */
      case 'bye': {
        const room = rooms.get(ws.roomId);
        if (room) {
          const other = ws.role === 'host' ? room.viewer : room.host;
          send(other, { type: 'peer-left' });
        }
        if (ws.role === 'host' && ws.roomId) {
          closeRoom(ws.roomId, 'host_left');
          ws.roomId = null;
        }
        break;
      }

      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;

      default:
        send(ws, { type: 'error', code: 'unknown', message: 'Unknown message type.' });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'host' && ws.roomId) {
      closeRoom(ws.roomId, 'host_left');
    } else if (ws.role === 'viewer') {
      const room = rooms.get(ws.roomId);
      if (room && room.viewer === ws) {
        room.viewer = null;
        send(room.host, { type: 'peer-left' });
      }
    }
  });
});

// keep the socket layer healthy
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30_000).unref();

// forget rooms that nobody has used for a while
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, room] of rooms) {
    const stale = room.createdAt < cutoff && !room.viewer;
    if (stale) closeRoom(id, 'idle');
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`ScreenLink relay listening on http://${HOST}:${PORT}  (ws://${HOST}:${PORT})`);
});
