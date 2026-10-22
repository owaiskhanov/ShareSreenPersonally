/* Minimal relay smoke test — no test framework, just node + ws.
 * Run: node tests/relay.test.js   (expects relay on PORT or starts one) */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}`;
const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

let server;
let failures = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond) {
  if (cond) console.log(`  ok    ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name}`); }
}

class Peer {
  constructor() {
    this.ws = new WebSocket(URL);
    this.inbox = [];
    this.ws.on('message', (raw) => this.inbox.push(JSON.parse(raw.toString())));
    this.ready = new Promise((res) => this.ws.once('open', res));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  async next(type, timeout = 1500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      await wait(20);
    }
    return null;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await wait(600);

  const id = '123456789';
  const pass = 'abc23456';
  const secret = sha(`${id}:${pass}`);
  const host = new Peer();
  await host.ready;

  host.send({ type: 'register', id, secret, name: 'Owais' });
  check('host registers', Boolean(await host.next('registered')));

  const dup = new Peer();
  await dup.ready;
  dup.send({ type: 'register', id, secret, name: 'impostor' });
  const dupErr = await dup.next('error');
  check('duplicate id is refused', dupErr && dupErr.code === 'id_taken');
  dup.close();

  const bad = new Peer();
  await bad.ready;
  bad.send({ type: 'join', id, secret: sha(`${id}:wrongpass`), name: 'Mallory' });
  const badErr = await bad.next('error');
  check('wrong password is refused', badErr && badErr.code === 'bad_password');
  check('host does not see a bad join', (await host.next('peer-joined', 400)) === null);
  bad.close();

  const viewer = new Peer();
  await viewer.ready;
  viewer.send({ type: 'join', id, secret, name: 'Friend' });
  check('right password joins', Boolean(await viewer.next('joined')));
  const joined = await host.next('peer-joined');
  check('host is told who joined', joined && joined.name === 'Friend');

  // handshake pass-through in both directions
  viewer.send({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });
  const offer = await host.next('offer');
  check('offer travels viewer -> host', offer && offer.sdp.sdp === 'v=0');

  host.send({ type: 'answer', sdp: { type: 'answer', sdp: 'v=1' } });
  const answer = await viewer.next('answer');
  check('answer travels host -> viewer', answer && answer.sdp.sdp === 'v=1');

  host.send({ type: 'ice', candidate: { candidate: 'candidate:1' } });
  check('ice reaches the viewer', Boolean(await viewer.next('ice')));

  // second viewer bumps the first
  const viewer2 = new Peer();
  await viewer2.ready;
  viewer2.send({ type: 'join', id, secret, name: 'Friend2' });
  check('second viewer joins', Boolean(await viewer2.next('joined')));
  const bumped = await viewer.next('closed', 1500);
  check('the older viewer is bumped', bumped && bumped.reason === 'replaced');
  viewer.close();

  // host leaving ends the session for everyone
  host.send({ type: 'bye' });
  const left = await viewer2.next('peer-left');
  check('viewer hears the host leave', Boolean(left));
  viewer2.close();

  // a joined viewer must not be able to delete/hijack the host's room
  const host2 = new Peer();
  await host2.ready;
  host2.send({ type: 'register', id: '222333444', secret: sha('2:3'), name: 'Host2' });
  check('second host registers', Boolean(await host2.next('registered')));

  const view2 = new Peer();
  await view2.ready;
  view2.send({ type: 'join', id: '222333444', secret: sha('2:3'), name: 'Viewer2' });
  check('viewer joins second host', Boolean(await view2.next('joined')));
  await host2.next('peer-joined');

  view2.send({ type: 'register', id: '888777666', secret: sha('8:9'), name: 'hijack' });
  const hijackErr = await view2.next('error');
  check('a viewer cannot register a room', hijackErr && hijackErr.code === 'bad_request');

  const probe = new Peer();
  await probe.ready;
  probe.send({ type: 'join', id: '222333444', secret: sha('2:3'), name: 'probe' });
  check('the host room survives the attempt', Boolean(await probe.next('joined')));
  probe.close();
  view2.close();
  host2.close();

  // brute force guard
  const bruteforce = [];
  for (let i = 0; i < 6; i += 1) {
    const p = new Peer();
    await p.ready;
    p.send({ type: 'join', id: '999888777', secret: sha('x:y') });
    bruteforce.push(await p.next('error'));
    p.close();
  }
  check('unknown id reads as not_found', bruteforce[0].code === 'not_found');

  await wait(150);
  console.log(failures === 0 ? '\nAll relay checks passed.' : `\n${failures} check(s) failed.`);
  server.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  if (server) server.kill();
  process.exit(1);
});
