export type Signal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'media'; state: 'started' | 'stopped' }
  | { type: 'reset' };
export interface ReceiverInfo {
  addresses: string[];
  port: number;
  key: string;
  expiresAt: number;
  name: string;
}
export interface DiscoveredReceiver {
  id: string;
  name: string;
  address: string;
  port: number;
}
export interface FirewallStatus {
  supported: boolean;
  configured: boolean;
  message: string;
}
export type AppEvent =
  | { type: 'signal'; signal: Signal }
  | { type: 'fullscreen'; enabled: boolean }
  | { type: 'peer-joined' }
  | { type: 'pair-request'; id: string; name: string; address: string }
  | { type: 'pair-request-ended'; id: string }
  | { type: 'peer-reconnecting'; reason: string }
  | { type: 'peer-rejoined' }
  | { type: 'peer-left'; reason: string }
  | { type: 'invite'; info: ReceiverInfo }
  | { type: 'error'; message: string };
export interface CaptureSource { id: string; name: string; thumbnail: string; kind: 'screen' | 'window' }
export interface TongpinAPI {
  version(): Promise<string>;
  receive(): Promise<ReceiverInfo>;
  connect(invitation: string): Promise<void>;
  discover(): Promise<DiscoveredReceiver[]>;
  connectDevice(id: string): Promise<void>;
  connectAddress(address: string): Promise<void>;
  respondPair(id: string, allow: boolean): Promise<void>;
  autoApproveNext(enabled: boolean): Promise<void>;
  firewallStatus(): Promise<FirewallStatus>;
  repairFirewall(): Promise<FirewallStatus>;
  sources(): Promise<CaptureSource[]>;
  selectSource(id: string): Promise<void>;
  signal(message: Signal): Promise<void>;
  stop(): Promise<void>;
  fullscreen(): Promise<boolean>;
  copy(value: string): Promise<void>;
  saveInvite(value: string): Promise<boolean>;
  openInvite(): Promise<string | null>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
