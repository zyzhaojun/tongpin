import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import type { DiscoveredReceiver } from '../shared/types';

const MAX_RESPONSE = 8 * 1024;
export interface FoundReceiver {
  device: DiscoveredReceiver;
  fingerprint: Buffer;
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

export function discoveryCandidates(): string[] {
  const hosts = new Set<string>();
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (!net || net.internal || net.family !== 'IPv4') continue;
    const value = ipv4Number(net.address);
    // A /24 sweep stays fast and predictable even on unusually broad campus subnets.
    const base = value & 0xffffff00;
    for (let host = 1; host < 255; host++) {
      const candidate = `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${host}`;
      if (candidate !== net.address) hosts.add(candidate);
    }
  }
  return [...hosts].slice(0, 1024);
}

export function sameLocalSubnet(remoteAddress: string | undefined): boolean {
  const normalized = remoteAddress?.replace(/^::ffff:/, '') ?? '';
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  const remote = ipv4Number(normalized);
  return Object.values(networkInterfaces()).flat().some(net => {
    if (!net || net.internal || net.family !== 'IPv4') return false;
    const mask = ipv4Number(net.netmask);
    return (remote & mask) === (ipv4Number(net.address) & mask);
  });
}

export async function probeReceiver(host: string, port = 48765, timeout = 650): Promise<FoundReceiver | null> {
  if (isIP(host) !== 4 || port < 1 || port > 65535) return null;
  return new Promise(resolve => {
    let settled = false;
    let data = Buffer.alloc(0);
    let fingerprint = Buffer.alloc(0);
    const finish = (value: FoundReceiver | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => finish(null), timeout);
    timer.unref();
    socket.once('error', () => finish(null));
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      fingerprint = raw ? Buffer.from(new X509Certificate(raw).fingerprint256.replaceAll(':', ''), 'hex') : Buffer.alloc(0);
      if (fingerprint.length !== 32) { finish(null); return; }
      socket.write(`GET /discover HTTP/1.1\r\nHost: ${host}:${port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (data.length > MAX_RESPONSE) finish(null);
    });
    socket.once('end', () => {
      try {
        const response = data.toString('utf8');
        if (!/^HTTP\/1\.1 200\b/.test(response)) { finish(null); return; }
        const separator = response.indexOf('\r\n\r\n');
        if (separator < 0) { finish(null); return; }
        const value = JSON.parse(response.slice(separator + 4)) as Record<string, unknown>;
        if (value.protocol !== 'tongpin/2' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) { finish(null); return; }
        const id = fingerprint.toString('base64url');
        finish({ device: { id, name: value.name.trim(), address: host, port }, fingerprint });
      } catch { finish(null); }
    });
  });
}

export async function discoverReceivers(hosts = discoveryCandidates(), port = 48765): Promise<FoundReceiver[]> {
  const input = [...new Set(hosts)].slice(0, 1024);
  const found = new Map<string, FoundReceiver>();
  let next = 0;
  const workers = Array.from({ length: Math.min(48, input.length) }, async () => {
    while (next < input.length) {
      const host = input[next++];
      const result = await probeReceiver(host, port);
      if (result && !found.has(result.device.id)) found.set(result.device.id, result);
    }
  });
  await Promise.all(workers);
  return [...found.values()].sort((a, b) => a.device.name.localeCompare(b.device.name, 'zh-CN'));
}
