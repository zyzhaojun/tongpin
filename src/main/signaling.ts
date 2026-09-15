import { createServer, type Server } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { generate } from 'selfsigned';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppEvent, ReceiverInfo, Signal } from '../shared/types';
import { sameLocalSubnet, type FoundReceiver } from './discovery';

const MAX_MESSAGE = 128 * 1024;
export const INVITE_TTL = 10 * 60 * 1000;
export const RESUME_TTL = 60 * 1000;
type Emit = (event: AppEvent) => void;

export function localAddresses(): string[] {
  const found = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x!.address);
  return [...new Set(found)].sort((a, b) => Number(a.startsWith('169.254.')) - Number(b.startsWith('169.254.')));
}

export function makeInvitation(host: string, info: ReceiverInfo): string {
  if (isIP(host) !== 4 || !info.addresses.includes(host)) throw new Error('接收地址无效');
  return `tongpin://${host}:${info.port}/${info.key}`;
}

export function parseInvitation(input: unknown): { host: string; port: number; fingerprint: Buffer; token: string } {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请粘贴接收端复制的完整连接信息');
  const clean = input.replace(/\s+/g, '');
  const match = /^tongpin:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\/([A-Za-z0-9_-]{64})$/.exec(clean);
  if (!match || isIP(match[1]) !== 4 || +match[2] < 1 || +match[2] > 65535) throw new Error('连接信息格式不正确，请重新从接收端复制');
  const bytes = Buffer.from(match[3], 'base64url');
  if (bytes.length !== 48 || bytes.toString('base64url') !== match[3]) throw new Error('连接密钥不正确');
  return { host: match[1], port: +match[2], fingerprint: bytes.subarray(0, 32), token: bytes.subarray(32).toString('base64url') };
}

export function validSignal(value: unknown, from: 'sender' | 'receiver'): value is Signal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (from === 'sender' && v.type === 'reset') return true;
  if (from === 'sender' && v.type === 'media') return v.state === 'started' || v.state === 'stopped';
  if (v.type === (from === 'sender' ? 'offer' : 'answer')) {
    return typeof v.sdp === 'string' && v.sdp.length > 0 && v.sdp.length < 100000 && !/(?:^|\r?\n)m=audio\s/.test(v.sdp);
  }
  if (v.type !== 'ice' || !v.candidate || typeof v.candidate !== 'object') return false;
  const c = v.candidate as Record<string, unknown>;
  return typeof c.candidate === 'string' && c.candidate.length <= 4096 &&
    (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length <= 64)) &&
    (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && Number(c.sdpMLineIndex) >= 0 && Number(c.sdpMLineIndex) < 16));
}

function heartbeat(ws: WebSocket): void {
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 10000);
  timer.unref();
  ws.once('close', () => clearInterval(timer));
}

function readMessage(raw: WebSocket.RawData): unknown {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}

export class Receiver {
  private server?: Server;
  private wss?: WebSocketServer;
  private peer?: WebSocket;
  private token = randomBytes(16);
  private resumeToken?: Buffer;
  private resumeUntil = 0;
  private fingerprint = Buffer.alloc(32);
  private port = 0;
  private expiry = Date.now() + INVITE_TTL;
  private rotation?: ReturnType<typeof setTimeout>;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private pending?: { id: string; ws: WebSocket; timer: ReturnType<typeof setTimeout>; accept: () => void; reject: () => void };
  private autoApprove = false;
  private closed = false;
  private attempts = new Map<string, { count: number; until: number }>();
  private sockets = new Set<TLSSocket>();
  constructor(private emit: Emit, private options: { port?: number; bind?: string; ttl?: number; resumeTtl?: number } = {}) {}

  info(): ReceiverInfo {
    return { addresses: localAddresses(), port: this.port, key: Buffer.concat([this.fingerprint, this.token]).toString('base64url'), expiresAt: this.expiry, name: hostname() };
  }

  private rotate(): void {
    clearTimeout(this.rotation);
    this.token = randomBytes(16);
    this.expiry = Date.now() + (this.options.ttl ?? INVITE_TTL);
    if (this.closed) return;
    this.rotation = setTimeout(() => { if (!this.peer) this.rotate(); }, this.options.ttl ?? INVITE_TTL);
    this.rotation.unref();
    this.emit({ type: 'invite', info: this.info() });
  }

  private finishPeer(reason: string): void {
    clearTimeout(this.resumeTimer);
    this.resumeToken = undefined;
    this.resumeUntil = 0;
    if (this.closed) return;
    this.rotate();
    this.emit({ type: 'peer-left', reason });
  }

  private awaitResume(): void {
    clearTimeout(this.resumeTimer);
    if (!this.resumeToken) { this.finishPeer('连接恢复超时，可使用新的连接信息再次连接'); return; }
    const remaining = this.options.resumeTtl ?? RESUME_TTL;
    this.resumeUntil = Date.now() + remaining;
    this.emit({ type: 'peer-reconnecting', reason: '连接中断，正在等待原电脑恢复…' });
    this.resumeTimer = setTimeout(() => {
      if (!this.peer) this.finishPeer('连接恢复超时，可使用新的连接信息再次连接');
    }, remaining);
    this.resumeTimer.unref();
  }

  private authenticate(ws: WebSocket, msg: Record<string, unknown> | null): 'initial' | 'resume' | null {
    if (this.peer) return null;
    const now = Date.now();
    if (msg?.type === 'resume' && typeof msg.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(msg.token)) {
      const candidate = Buffer.from(msg.token, 'base64url');
      if (this.resumeToken && now < this.resumeUntil && candidate.length === 32 && timingSafeEqual(candidate, this.resumeToken)) return 'resume';
      return null;
    }
    if (msg?.type !== 'auth' || this.resumeToken || now >= this.expiry || typeof msg.token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(msg.token)) return null;
    const candidate = Buffer.from(msg.token, 'base64url');
    if (candidate.length !== 16 || !timingSafeEqual(candidate, this.token)) return null;
    this.resumeToken = randomBytes(32);
    this.resumeUntil = 0;
    return 'initial';
  }

  respondPair(id: string, allow: boolean): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) throw new Error('该连接请求已经失效');
    if (allow) pending.accept();
    else pending.reject();
  }

  setAutoApproveNext(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  async start(): Promise<ReceiverInfo> {
    const pems = await generate([{ name: 'commonName', value: 'Tongpin local receiver' }], { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 86400000) });
    if (this.closed) throw new Error('接收已取消');
    this.fingerprint = Buffer.from(new X509Certificate(pems.cert).fingerprint256.replaceAll(':', ''), 'hex');
    this.server = createServer({ key: pems.private, cert: pems.cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, (req, res) => {
      if (req.method === 'GET' && req.url === '/discover' && sameLocalSubnet(req.socket.remoteAddress)) {
        if (this.peer || this.resumeToken || this.pending) {
          res.writeHead(409, { 'Cache-Control': 'no-store', 'Content-Length': '0' }); res.end(); return;
        }
        const body = Buffer.from(JSON.stringify({ protocol: 'tongpin/2', name: hostname() }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) });
        res.end(body); return;
      }
      res.writeHead(404, { 'Content-Length': '0' }); res.end();
    });
    this.server.maxConnections = 16;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    this.server.on('connection', socket => {
      this.sockets.add(socket as TLSSocket);
      socket.once('close', () => this.sockets.delete(socket as TLSSocket));
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/signal', maxPayload: MAX_MESSAGE, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => {
      ws.on('error', () => {});
      const ip = req.socket.remoteAddress ?? 'unknown';
      const prior = this.attempts.get(ip);
      if (this.closed) { ws.close(1001, '接收端已关闭'); return; }
      if (this.wss!.clients.size > 8) { ws.close(1013, '连接过多'); return; }
      let authenticated = false;
      let intentional = false;
      const timer = setTimeout(() => ws.terminate(), 5000);
      timer.unref();
      const establish = (mode: 'initial' | 'resume') => {
        authenticated = true;
        this.attempts.delete(ip);
        clearTimeout(timer);
        clearTimeout(this.rotation);
        clearTimeout(this.resumeTimer);
        this.peer = ws;
        heartbeat(ws);
        if (mode === 'resume') {
          this.resumeUntil = 0;
          this.emit({ type: 'peer-rejoined' });
        } else this.emit({ type: 'peer-joined' });
        ws.send(JSON.stringify({ type: 'ready', resumeToken: this.resumeToken!.toString('base64url'), resumed: mode === 'resume' }));
      };
      ws.once('close', () => {
        clearTimeout(timer);
        if (this.pending?.ws === ws) {
          const request = this.pending;
          this.pending = undefined;
          clearTimeout(request.timer);
          this.emit({ type: 'pair-request-ended', id: request.id });
        }
        if (this.peer === ws) {
          this.peer = undefined;
          if (!this.closed) {
            if (intentional) this.finishPeer('投屏连接已结束，可使用新的连接信息再次连接');
            else this.awaitResume();
          }
        }
      });
      ws.on('message', (raw, binary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (binary) { ws.close(1008, '消息格式不正确'); return; }
        const msg = readMessage(raw) as Record<string, unknown> | null;
        if (!authenticated) {
          if (msg?.type === 'request') {
            const rawName = typeof msg.name === 'string' ? msg.name.trim().replace(/[\u0000-\u001f\u007f]/g, '') : '';
            const validId = typeof msg.deviceId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(msg.deviceId);
            if (!sameLocalSubnet(ip) || !rawName || rawName.length > 80 || !validId || this.peer || this.resumeToken || this.pending) {
              ws.close(1008, this.peer || this.resumeToken || this.pending ? '大屏正在接收或处理其他连接' : '设备信息无效'); return;
            }
            clearTimeout(timer);
            const id = randomBytes(12).toString('base64url');
            const requestTimer = setTimeout(() => {
              if (this.pending?.id === id) this.pending.reject();
            }, 30000);
            requestTimer.unref();
            const finishRequest = () => {
              if (this.pending?.id !== id) return false;
              this.pending = undefined;
              clearTimeout(requestTimer);
              this.emit({ type: 'pair-request-ended', id });
              return true;
            };
            this.pending = {
              id, ws, timer: requestTimer,
              accept: () => {
                if (!finishRequest() || ws.readyState !== WebSocket.OPEN || this.closed || this.peer || this.resumeToken) return;
                this.resumeToken = randomBytes(32);
                establish('initial');
              },
              reject: () => {
                if (!finishRequest()) return;
                ws.close(1008, '接收端未允许本次投屏');
              }
            };
            this.emit({ type: 'pair-request', id, name: rawName, address: ip.replace(/^::ffff:/, '') });
            if (this.autoApprove) {
              this.autoApprove = false;
              queueMicrotask(() => { if (this.pending?.id === id) this.pending.accept(); });
            }
            return;
          }
          const mode = this.authenticate(ws, msg);
          if (!mode) {
            if (prior && prior.until > Date.now() && prior.count >= 5) {
              ws.close(1008, '尝试次数过多，请一分钟后重试'); return;
            }
            if (this.attempts.size > 256) this.attempts.clear();
            const latest = this.attempts.get(ip);
            const attempts = latest && latest.until > Date.now() ? latest.count + 1 : 1;
            this.attempts.set(ip, { count: attempts, until: Date.now() + 60000 });
            const reason = this.peer || this.resumeToken ? '大屏正在接收或等待原电脑恢复' : '连接信息已失效或不正确，请重新复制';
            ws.close(1008, reason); return;
          }
          establish(mode);
          return;
        }
        if (msg?.type === 'bye') {
          intentional = true;
          ws.close(1000, '发送端已断开');
          return;
        }
        if (this.peer !== ws || !validSignal(msg, 'sender')) { ws.close(1008, '不支持的投屏消息'); return; }
        this.emit({ type: 'signal', signal: msg });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port ?? 48765, this.options.bind ?? '0.0.0.0', () => {
        this.server!.removeListener('error', reject);
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
    this.server.on('error', error => this.emit({ type: 'error', message: error.message }));
    this.rotate();
    return this.info();
  }

  send(signal: unknown): void {
    if (!validSignal(signal, 'receiver')) throw new Error('接收端消息无效');
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN) throw new Error('发送端已断开');
    this.peer.send(JSON.stringify(signal));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.autoApprove = false;
    clearTimeout(this.rotation);
    clearTimeout(this.resumeTimer);
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      try { pending.ws.close(1001, '接收端已结束接收'); } catch { pending.ws.terminate(); }
    }
    for (const ws of this.wss?.clients ?? []) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'shutdown', reason: '接收端已结束接收' })); ws.close(1001, '接收端已结束接收'); } catch { ws.terminate(); }
      } else ws.terminate();
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.peer = undefined;
    this.resumeToken = undefined;
  }
}

// The sole untrusted TLS handshake carries no application data. The socket is
// given to WebSocket only AFTER its certificate matches the out-of-band key.
async function pinnedSocket(host: string, port: number, expected: Buffer): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时，请检查地址、网络互通和接收端防火墙')); }, 7000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      const actual = raw ? Buffer.from(new X509Certificate(raw).fingerprint256.replaceAll(':', ''), 'hex') : Buffer.alloc(0);
      clearTimeout(timer);
      if (actual.length !== 32 || !timingSafeEqual(actual, expected)) {
        socket.destroy(); reject(new Error('接收设备身份不匹配，请重新从大屏复制连接信息')); return;
      }
      resolve(socket);
    });
  });
}

export class Sender {
  private ws?: WebSocket;
  private socket?: TLSSocket;
  private closed = false;
  private target?: { host: string; port: number; fingerprint: Buffer; token?: string };
  private resumeToken?: string;
  private reconnecting = false;
  private reconnectDeadline = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  constructor(private emit: Emit) {}

  async connect(invitation: string): Promise<void> {
    this.target = parseInvitation(invitation);
    this.closed = false;
    this.resumeToken = undefined;
    await this.open({ type: 'auth', token: this.target.token! });
  }

  async connectDiscovered(found: FoundReceiver): Promise<void> {
    if (isIP(found.device.address) !== 4 || found.device.port < 1 || found.device.port > 65535 || found.fingerprint.length !== 32) throw new Error('发现的接收设备信息无效');
    this.target = { host: found.device.address, port: found.device.port, fingerprint: Buffer.from(found.fingerprint) };
    this.closed = false;
    this.resumeToken = undefined;
    await this.open({ type: 'request', name: hostname().slice(0, 80), deviceId: randomBytes(16).toString('base64url') });
  }

  private async open(auth: { type: 'auth' | 'resume'; token: string } | { type: 'request'; name: string; deviceId: string }): Promise<void> {
    const parsed = this.target;
    if (!parsed) throw new Error('尚未配置接收端');
    const socket = this.socket = await pinnedSocket(parsed.host, parsed.port, parsed.fingerprint);
    if (this.closed) { this.socket.destroy(); throw new Error('连接已取消'); }
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws = new WebSocket(`wss://${parsed.host}:${parsed.port}/signal`, { createConnection: () => socket, maxPayload: MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: 7000 });
      let ready = false;
      let endedByPeer = false;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('配对超时，请在大屏上允许连接后重试')); }, auth.type === 'request' ? 35000 : 7000);
      timer.unref();
      ws.on('error', error => { clearTimeout(timer); if (!ready) reject(error); });
      ws.on('open', () => ws.send(JSON.stringify(auth)));
      ws.on('message', (raw, binary) => {
        const msg = binary ? null : readMessage(raw) as Record<string, unknown> | null;
        if (!ready && msg?.type === 'ready') {
          const token = typeof msg.resumeToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(msg.resumeToken) ? Buffer.from(msg.resumeToken, 'base64url') : Buffer.alloc(0);
          if (token.length !== 32) { clearTimeout(timer); ws.close(1008, '恢复凭据无效'); reject(new Error('接收端未提供有效的恢复凭据')); return; }
          this.resumeToken = msg.resumeToken as string;
          ready = true; clearTimeout(timer); heartbeat(ws); resolve(); return;
        }
        if (ready && msg?.type === 'shutdown') {
          endedByPeer = true;
          const reason = typeof msg.reason === 'string' ? msg.reason : '接收端已结束接收';
          this.emit({ type: 'peer-left', reason });
          ws.close(1001, reason);
          return;
        }
        if (!ready || !validSignal(msg, 'receiver')) { ws.close(1008, '不支持的投屏消息'); return; }
        this.emit({ type: 'signal', signal: msg });
      });
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        const message = reason.toString() || '与大屏的连接已断开，请重新连接';
        if (!ready) reject(new Error(message));
        if (this.ws === ws) this.ws = undefined;
        if (ready && !this.closed && !endedByPeer) {
          if (code === 1000 || code === 1001) this.emit({ type: 'peer-left', reason: message });
          else this.beginReconnect(message);
        }
      });
    });
  }

  private beginReconnect(reason: string): void {
    if (this.closed || this.reconnecting || !this.resumeToken) {
      if (!this.closed) this.emit({ type: 'peer-left', reason });
      return;
    }
    this.reconnecting = true;
    this.reconnectDeadline = Date.now() + RESUME_TTL;
    this.emit({ type: 'peer-reconnecting', reason: '连接中断，正在自动恢复…' });
    this.scheduleReconnect(300);
  }

  private scheduleReconnect(delay: number): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { void this.tryReconnect(delay); }, delay);
    this.reconnectTimer.unref();
  }

  private async tryReconnect(previousDelay: number): Promise<void> {
    if (this.closed || !this.reconnecting || !this.resumeToken) return;
    try {
      await this.open({ type: 'resume', token: this.resumeToken });
      if (this.closed) return;
      this.reconnecting = false;
      this.emit({ type: 'peer-rejoined' });
    } catch {
      if (this.closed || !this.reconnecting) return;
      if (Date.now() >= this.reconnectDeadline) {
        this.reconnecting = false;
        this.emit({ type: 'peer-left', reason: '网络在 60 秒内未恢复，请重新获取连接信息' });
        return;
      }
      this.scheduleReconnect(Math.min(5000, Math.max(700, previousDelay * 2)));
    }
  }

  send(signal: unknown): void {
    if (!validSignal(signal, 'sender')) throw new Error('发送端消息无效');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('大屏连接已断开');
    this.ws.send(JSON.stringify(signal));
  }

  close(): void {
    this.closed = true;
    this.reconnecting = false;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'bye' }), () => ws.close(1000, '发送端已断开'));
        const timer = setTimeout(() => ws.terminate(), 250);
        timer.unref();
      } catch { ws.terminate(); }
    } else {
      ws?.terminate();
      this.socket?.destroy();
    }
  }
}
