const test = require('node:test');
const assert = require('node:assert/strict');
const { Receiver, Sender, makeInvitation, parseInvitation, validSignal } = require('../build/signaling.cjs');
const { discoverReceivers, probeReceiver, sameLocalSubnet } = require('../build/discovery.cjs');
const { firewallInstallScript, FIREWALL_RULE } = require('../build/firewall.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Timed out waiting for event'); await delay(20); }
}
async function fixture(t, options = {}) {
  const events = [];
  const receiver = new Receiver(event => events.push(event), { bind: '127.0.0.1', port: 0, ...options });
  const info = await receiver.start();
  info.addresses.push('127.0.0.1');
  const invite = makeInvitation('127.0.0.1', info);
  t.after(() => receiver.close());
  return { receiver, info, invite, events };
}

test('connection information rejects malformed addresses, schemes, oversized data and truncated keys', () => {
  for (const input of ['', null, 'http://localhost/', 'tongpin://localhost:48765/' + 'A'.repeat(64), 'tongpin://999.1.1.1:4/' + 'A'.repeat(64), 'tongpin://127.0.0.1:65536/' + 'A'.repeat(64), 'A'.repeat(2049)]) {
    assert.throws(() => parseInvitation(input));
  }
  assert.throws(() => makeInvitation('127.0.0.2', { addresses: ['127.0.0.1'] }));
});

test('signal validation rejects audio, wrong roles, malformed candidates and oversized SDP', () => {
  assert.equal(validSignal({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' }, 'sender'), true);
  assert.equal(validSignal({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' }, 'sender'), false);
  assert.equal(validSignal({ type: 'answer', sdp: 'v=0' }, 'sender'), false);
  assert.equal(validSignal({ type: 'media', state: 'stopped' }, 'sender'), true);
  assert.equal(validSignal({ type: 'media', state: 'started' }, 'receiver'), false);
  assert.equal(validSignal({ type: 'reset' }, 'sender'), true);
  assert.equal(validSignal({ type: 'reset' }, 'receiver'), false);
  assert.equal(validSignal({ type: 'offer', sdp: 'v'.repeat(100001) }, 'sender'), false);
  assert.equal(validSignal({ type: 'ice', candidate: { candidate: 10 } }, 'sender'), false);
  assert.equal(validSignal({ type: 'ice', candidate: { candidate: 'candidate:1', sdpMLineIndex: -1 } }, 'receiver'), false);
});

test('discovery exposes only public device data and pairs after receiver approval', async t => {
  const f = await fixture(t);
  const found = await probeReceiver('127.0.0.1', f.info.port, 2000);
  assert.ok(found);
  assert.equal(found.device.address, '127.0.0.1');
  assert.equal(found.device.port, f.info.port);
  assert.equal(found.fingerprint.length, 32);
  assert.equal('key' in found.device, false);
  const scanned = await discoverReceivers(['127.0.0.1'], f.info.port);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].device.id, found.device.id);
  const sender = new Sender(() => {});
  t.after(() => sender.close());
  const connecting = sender.connectDiscovered(found);
  await until(() => f.events.some(event => event.type === 'pair-request'));
  assert.equal(f.events.some(event => event.type === 'peer-joined'), false);
  const request = f.events.find(event => event.type === 'pair-request');
  f.receiver.respondPair(request.id, true);
  await connecting;
  assert.ok(f.events.some(event => event.type === 'peer-joined'));
});

test('receiver rejection returns the sender to a safe disconnected state', async t => {
  const f = await fixture(t);
  const found = await probeReceiver('127.0.0.1', f.info.port, 2000);
  assert.ok(found);
  const sender = new Sender(() => {});
  t.after(() => sender.close());
  const connecting = sender.connectDiscovered(found);
  await until(() => f.events.some(event => event.type === 'pair-request'));
  const request = f.events.find(event => event.type === 'pair-request');
  f.receiver.respondPair(request.id, false);
  await assert.rejects(connecting, /未允许/);
  assert.equal(f.events.some(event => event.type === 'peer-joined'), false);
});

test('receiver can auto-approve exactly the next discovered device', async t => {
  const f = await fixture(t);
  const found = await probeReceiver('127.0.0.1', f.info.port, 2000);
  assert.ok(found);
  f.receiver.setAutoApproveNext(true);
  const sender = new Sender(() => {});
  t.after(() => sender.close());
  await sender.connectDiscovered(found);
  assert.ok(f.events.some(event => event.type === 'pair-request'));
  assert.ok(f.events.some(event => event.type === 'peer-joined'));
});

test('discovery and firewall helpers keep the LAN boundary explicit', () => {
  assert.equal(sameLocalSubnet('127.0.0.1'), true);
  const script = firewallInstallScript();
  assert.match(script, new RegExp(FIREWALL_RULE));
  assert.match(script, /LocalSubnet/);
  assert.match(script, /TCP/);
  assert.match(script, /48765/);
});

test('an unexpected signaling interruption resumes with a session credential', async t => {
  const f = await fixture(t, { resumeTtl: 3000 });
  const senderEvents = [];
  const sender = new Sender(event => senderEvents.push(event));
  t.after(() => sender.close());
  await sender.connect(f.invite);
  const originalKey = f.receiver.info().key;
  assert.ok(f.receiver.peer, 'receiver did not retain the active WebSocket');
  f.receiver.peer.terminate();
  await until(() => senderEvents.some(event => event.type === 'peer-reconnecting'));
  await until(() => senderEvents.some(event => event.type === 'peer-rejoined'), 5000);
  await until(() => f.events.some(event => event.type === 'peer-rejoined'));
  assert.equal(f.receiver.info().key, originalKey);
  sender.send({ type: 'media', state: 'stopped' });
  await until(() => f.events.some(event => event.type === 'signal' && event.signal.type === 'media'));
});

test('real TLS and WebSocket pair, relay offer/answer/ICE, and rotate keys after disconnect', async t => {
  const f = await fixture(t);
  const received = [];
  const sender = new Sender(event => received.push(event));
  t.after(() => sender.close());
  await sender.connect(f.invite);
  assert.ok(f.events.some(event => event.type === 'peer-joined'));
  sender.send({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' });
  await until(() => f.events.some(event => event.type === 'signal'));
  f.receiver.send({ type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' });
  await until(() => received.some(event => event.type === 'signal'));
  sender.send({ type: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });
  await until(() => f.events.filter(event => event.type === 'signal').length === 2);
  sender.close();
  await until(() => f.events.some(event => event.type === 'peer-left'));
  assert.notEqual(f.receiver.info().key, f.info.key);
  const replay = new Sender(() => {});
  t.after(() => replay.close());
  await assert.rejects(replay.connect(f.invite), /失效|不正确/);
});

test('certificate mismatch is rejected before authentication reaches the receiver', async t => {
  const f = await fixture(t);
  const key = Buffer.from(f.info.key, 'base64url');
  key[0] ^= 0xff;
  const bad = f.invite.slice(0, f.invite.lastIndexOf('/') + 1) + key.toString('base64url');
  const sender = new Sender(() => {});
  t.after(() => sender.close());
  await assert.rejects(sender.connect(bad), /身份不匹配/);
  assert.equal(f.events.filter(event => event.type === 'peer-joined').length, 0);
});

test('wrong token guesses are rate-limited without blocking valid credentials', async t => {
  const f = await fixture(t);
  const key = Buffer.from(f.info.key, 'base64url');
  key[47] ^= 0xff;
  const bad = f.invite.slice(0, f.invite.lastIndexOf('/') + 1) + key.toString('base64url');
  for (let i = 0; i < 5; i++) {
    const sender = new Sender(() => {});
    try { await assert.rejects(sender.connect(bad), /失效|不正确/); } finally { sender.close(); }
  }
  const limited = new Sender(() => {});
  try { await assert.rejects(limited.connect(bad), /次数过多/); } finally { limited.close(); }
  const valid = new Sender(() => {});
  t.after(() => valid.close());
  await valid.connect(f.invite);
  assert.equal(f.events.filter(event => event.type === 'peer-joined').length, 1);
});

test('an occupied receiver refuses another sender without disturbing the active sender', async t => {
  const f = await fixture(t);
  const first = new Sender(() => {}), second = new Sender(() => {});
  t.after(() => { first.close(); second.close(); });
  await first.connect(f.invite);
  await assert.rejects(second.connect(f.invite), /正在接收/);
  first.send({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' });
  await until(() => f.events.some(event => event.type === 'signal'));
});

test('expired invitations rotate and receiver shutdown disconnects the sender', async t => {
  const f = await fixture(t, { ttl: 300 });
  await until(() => f.receiver.info().key !== f.info.key);
  const old = new Sender(() => {});
  try { await assert.rejects(old.connect(f.invite), /失效|不正确/); } finally { old.close(); }
  const info = f.receiver.info();
  info.addresses.push('127.0.0.1');
  const received = [];
  const sender = new Sender(event => received.push(event));
  t.after(() => sender.close());
  await sender.connect(makeInvitation('127.0.0.1', info));
  await f.receiver.close();
  await until(() => received.some(event => event.type === 'peer-left'));
});
