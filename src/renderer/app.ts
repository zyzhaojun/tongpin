import type { AppEvent, CaptureSource, DiscoveredReceiver, ReceiverInfo, Signal, TongpinAPI } from '../shared/types';

declare global { interface Window { tongpin: TongpinAPI } }

type AppState =
  | 'home'
  | 'sender-disconnected'
  | 'sender-connecting'
  | 'sender-ready'
  | 'sender-sharing'
  | 'sender-reconnecting'
  | 'receiver-listening'
  | 'receiver-paired'
  | 'receiver-playing'
  | 'receiver-reconnecting';

const api = window.tongpin;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, yes = true) => { el(id).hidden = !yes; };
const button = (id: string) => el<HTMLButtonElement>(id);
let state: AppState = 'home';
let info: ReceiverInfo | undefined;
let sources: CaptureSource[] = [];
let devices: DiscoveredReceiver[] = [];
let chosen: CaptureSource | undefined;
let currentPairId: string | undefined;
let pc: RTCPeerConnection | undefined;
let senderTransceiver: RTCRtpTransceiver | undefined;
let media: MediaStream | undefined;
let remoteStream: MediaStream | undefined;
let pendingICE: RTCIceCandidateInit[] = [];
let signalQueue = Promise.resolve();
let statsTimer: ReturnType<typeof setInterval> | undefined;
let mediaFailureTimer: ReturnType<typeof setTimeout> | undefined;
let sessionEpoch = 0;
let mediaEpoch = 0;

const senderState = () => state.startsWith('sender-');
const receiverState = () => state.startsWith('receiver-');
const paired = () => ['sender-ready', 'sender-sharing', 'sender-reconnecting', 'receiver-paired', 'receiver-playing', 'receiver-reconnecting'].includes(state);

function transition(next: AppState): void { state = next; }
function status(value: string, statusState = 'ready'): void {
  el('status-text').textContent = value;
  el('status-dot').dataset.state = statusState;
}
function message(error?: unknown): void {
  if (!error) { show('notice', false); return; }
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  if (/ECONNREFUSED/.test(text)) text = '接收电脑未开启接收，或地址和端口不正确。请重新复制连接信息。';
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(text)) text = '无法访问接收电脑。请检查两台电脑是否在可互通的局域网，以及防火墙设置。';
  el('notice').textContent = text;
  show('notice');
}
function view(next: 'home' | 'send' | 'receive'): void {
  for (const id of ['home', 'send', 'receive']) show(id, id === next);
  document.body.dataset.playing = 'false';
  message();
}
function clearTimers(): void {
  clearInterval(statsTimer);
  clearTimeout(mediaFailureTimer);
  statsTimer = undefined;
  mediaFailureTimer = undefined;
}
function stopCapture(): void {
  const old = media;
  media = undefined;
  for (const track of old?.getTracks() ?? []) { track.onended = null; track.stop(); }
  el<HTMLVideoElement>('local-video').srcObject = null;
}
function detachRemote(): void {
  const video = el<HTMLVideoElement>('remote-video');
  video.onplaying = null;
  video.pause();
  video.srcObject = null;
  document.body.dataset.playing = 'false';
  el('stats').textContent = '';
}
function closePeer(): void {
  clearTimers();
  const old = pc;
  pc = undefined;
  senderTransceiver = undefined;
  pendingICE = [];
  if (old) {
    old.onconnectionstatechange = null;
    old.onicecandidate = null;
    old.ontrack = null;
    old.close();
  }
  for (const track of remoteStream?.getTracks() ?? []) track.stop();
  remoteStream = undefined;
  detachRemote();
}
function cleanupSessionMedia(): void {
  mediaEpoch++;
  stopCapture();
  closePeer();
}
function senderReadyUI(): void {
  show('connect-card', false);
  show('source-panel');
  show('sharing-panel', false);
  show('cancel-change', false);
  renderSources();
}
function senderDisconnectedUI(): void {
  show('connect-card');
  show('source-panel', false);
  show('sharing-panel', false);
  show('cancel-change', false);
  chosen = undefined;
  button('start-share').disabled = true;
  renderDevices();
}
function receiverWaitingForMedia(text: string): void {
  detachRemote();
  show('waiting-panel', false);
  show('receive-stage');
  show('receive-overlay');
  el('receive-overlay').textContent = text;
  el('receive-title').textContent = '等待画面';
}
async function run(id: string, work: () => Promise<void>): Promise<void> {
  button(id).disabled = true;
  message();
  try { await work(); }
  catch (error) { message(error); status('请检查提示后重试', 'error'); }
  finally { button(id).disabled = false; }
}
function bind(id: string, work: () => Promise<void>): void {
  button(id).addEventListener('click', () => { void run(id, work); });
}

function invitation(): string {
  return info ? `tongpin://${el<HTMLSelectElement>('address').value}:${info.port}/${info.key}` : '';
}
function updateInfo(value: ReceiverInfo): void {
  info = value;
  const select = el<HTMLSelectElement>('address');
  const previous = select.value;
  select.replaceChildren(...info.addresses.map(address => {
    const option = document.createElement('option');
    option.value = address;
    option.textContent = `${address}:${info!.port}`;
    return option;
  }));
  if (info.addresses.includes(previous)) select.value = previous;
  el('receiver-name').textContent = `这台设备：${info.name}`;
  el<HTMLTextAreaElement>('receiver-invite').value = invitation();
  updateExpiry();
}
function updateExpiry(): void {
  if (!info) return;
  const seconds = Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000));
  el('expiry').textContent = paired() ? '当前设备已配对，短暂断网会自动恢复' : `连接信息将在 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后自动更新`;
}
el('address').addEventListener('change', () => { el<HTMLTextAreaElement>('receiver-invite').value = invitation(); });
setInterval(updateExpiry, 1000);

function renderSources(): void {
  const kind = el<HTMLSelectElement>('source-kind').value;
  const visible = sources.filter(source => source.kind === kind);
  if (!visible.some(x => x.id === chosen?.id)) chosen = undefined;
  const container = el('sources');
  container.replaceChildren();
  for (const source of visible) {
    const item = document.createElement('button');
    item.className = 'source-card';
    item.setAttribute('aria-pressed', String(source.id === chosen?.id));
    item.setAttribute('aria-label', source.name);
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = source.name;
    item.append(image, label);
    item.addEventListener('click', () => { chosen = source; renderSources(); });
    container.append(item);
  }
  if (!visible.length) {
    const text = document.createElement('p');
    text.className = 'hint';
    text.textContent = kind === 'window' ? '未找到可分享的窗口。请先打开演示窗口，再点击刷新。' : '未找到屏幕，请检查显示器连接。';
    container.append(text);
  }
  button('start-share').textContent = media ? '切换画面' : '开始投屏';
  button('start-share').disabled = !chosen || !['sender-ready', 'sender-sharing'].includes(state);
}
function renderDevices(): void {
  const container = el('devices');
  container.replaceChildren();
  for (const device of devices) {
    const item = document.createElement('button');
    item.className = 'device-card';
    item.setAttribute('aria-label', `${device.name} ${device.address}`);
    const symbol = document.createElement('span');
    symbol.className = 'device-symbol';
    symbol.textContent = '▣';
    symbol.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = device.name;
    const address = document.createElement('span');
    address.textContent = `${device.address}:${device.port}`;
    text.append(name, address);
    item.append(symbol, text);
    item.addEventListener('click', () => {
      item.disabled = true;
      message();
      void connectSender(() => api.connectDevice(device.id)).catch(error => message(error)).finally(() => { item.disabled = false; });
    });
    container.append(item);
  }
}
async function scanDevices(): Promise<void> {
  const stamp = sessionEpoch;
  el('discovery-hint').textContent = '正在局域网中查找…';
  button('refresh-devices').disabled = true;
  try {
    const result = await api.discover();
    if (stamp !== sessionEpoch || state !== 'sender-disconnected') return;
    devices = result;
    renderDevices();
    el('discovery-hint').textContent = devices.length ? `找到 ${devices.length} 台正在接收的设备` : '暂未找到设备，可重新查找或输入大屏 IP';
    status(devices.length ? '请选择要连接的大屏' : '未发现大屏，请检查接收端和防火墙', devices.length ? 'ready' : 'busy');
  } finally {
    button('refresh-devices').disabled = false;
  }
}
async function refreshSources(): Promise<void> {
  const stamp = sessionEpoch;
  const result = await api.sources();
  if (stamp !== sessionEpoch || !senderState()) return;
  sources = result;
  renderSources();
}
el('source-kind').addEventListener('change', renderSources);

function qualitySettings(): { height: number; width: number; bitrate: number } {
  const height = +el<HTMLSelectElement>('quality').value;
  return { height, width: Math.round(height * 16 / 9), bitrate: height === 720 ? 3500000 : 6500000 };
}
async function configureSender(track: MediaStreamTrack, transceiver: RTCRtpTransceiver): Promise<void> {
  const quality = qualitySettings();
  track.contentHint = 'detail';
  const parameters = transceiver.sender.getParameters();
  if (parameters.encodings.length) {
    parameters.encodings[0].maxBitrate = quality.bitrate;
    parameters.encodings[0].maxFramerate = 30;
  }
  parameters.degradationPreference = 'maintain-resolution';
  await transceiver.sender.setParameters(parameters);
}
async function updateQuality(): Promise<void> {
  const track = media?.getVideoTracks()[0];
  if (!track || !senderTransceiver) return;
  const quality = qualitySettings();
  try {
    await track.applyConstraints({ width: { ideal: quality.width, max: quality.width }, height: { ideal: quality.height, max: quality.height }, frameRate: { ideal: 30, max: 30 } });
    await configureSender(track, senderTransceiver);
    status(`画质已调整为 ${quality.height}p，投屏连接保持不变`);
  } catch (error) { message(error); status('无法调整画质，当前投屏继续', 'error'); }
}
el('quality').addEventListener('change', () => { void updateQuality(); });

function beginStats(connection: RTCPeerConnection): void {
  let lastBytes = 0;
  let lastTime = 0;
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (pc !== connection || connection.connectionState !== 'connected') return;
    try {
      const stats = await connection.getStats();
      let fps = 0, width = 0, height = 0, bytes = 0, timestamp = 0, rtt: number | undefined;
      stats.forEach(report => {
        if ((report.type === 'outbound-rtp' || report.type === 'inbound-rtp') && report.kind === 'video') {
          fps = report.framesPerSecond ?? 0;
          width = report.frameWidth ?? 0;
          height = report.frameHeight ?? 0;
          bytes = report.bytesSent ?? report.bytesReceived ?? 0;
          timestamp = report.timestamp;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated && report.currentRoundTripTime != null) rtt = Math.round(report.currentRoundTripTime * 1000);
      });
      const mbps = timestamp > lastTime && lastTime ? Math.max(0, (bytes - lastBytes) * 8 / ((timestamp - lastTime) * 1000)) : 0;
      lastBytes = bytes;
      lastTime = timestamp;
      if (pc !== connection) return;
      el('stats').textContent = `${width || '—'} × ${height || '—'} · ${Math.round(fps)} fps · ${mbps.toFixed(1)} Mbps${rtt === undefined ? '' : ` · 往返 ${rtt} ms`}`;
    } catch { /* The peer can disappear between stats calls. */ }
  }, 1000);
}

async function sendSignal(signal: Signal): Promise<boolean> {
  try { await api.signal(signal); return true; }
  catch {
    status('信令暂时不可用，正在等待连接恢复…', 'busy');
    return false;
  }
}
function attachRemote(stream: MediaStream): void {
  remoteStream = stream;
  const video = el<HTMLVideoElement>('remote-video');
  video.srcObject = stream;
  video.onplaying = () => {
    if (remoteStream !== stream || !receiverState()) return;
    transition('receiver-playing');
    show('receive-overlay', false);
    document.body.dataset.playing = 'true';
    el('receive-title').textContent = '正在接收画面';
    status('已连接 · 正在接收画面');
  };
  void video.play().catch(() => {
    if (remoteStream !== stream || !receiverState()) return;
    setTimeout(() => { if (remoteStream === stream) void video.play().catch(() => {}); }, 150);
  });
}
function recoverMedia(reason: string): void {
  if (!pc) return;
  closePeer();
  if (senderState()) {
    stopCapture();
    if (state !== 'sender-reconnecting') transition('sender-ready');
    senderReadyUI();
    status(`${reason}。与大屏仍保持配对，可重新开始`, 'error');
  } else if (receiverState()) {
    transition(state === 'receiver-reconnecting' ? 'receiver-reconnecting' : 'receiver-paired');
    receiverWaitingForMedia(`${reason}，等待笔记本重新开始…`);
    status('设备仍已配对 · 等待重新投屏', 'busy');
  }
}
function ensurePeer(): RTCPeerConnection {
  if (pc) return pc;
  const connection = pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  connection.onicecandidate = event => {
    if (event.candidate && pc === connection) void sendSignal({ type: 'ice', candidate: event.candidate.toJSON() });
  };
  connection.ontrack = event => {
    if (pc !== connection) return;
    if (event.track.kind !== 'video') { event.track.stop(); recoverMedia('收到不支持的媒体类型'); return; }
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    remoteStream = stream;
    event.track.onunmute = () => { if (pc === connection && receiverState()) attachRemote(stream); };
    event.track.onended = () => { if (pc === connection) recoverMedia('对方的画面轨道已结束'); };
    if (!event.track.muted) attachRemote(stream);
  };
  connection.onconnectionstatechange = () => {
    if (pc !== connection) return;
    const connectionState = connection.connectionState;
    if (connectionState === 'connected') {
      clearTimeout(mediaFailureTimer);
      if (state === 'sender-sharing') status('已连接 · 正在分享画面');
      else if (state === 'receiver-playing') status('已连接 · 正在接收画面');
      beginStats(connection);
    } else if (connectionState === 'disconnected') {
      status('画面连接中断，正在尝试恢复…', 'busy');
      if (receiverState()) { show('receive-overlay'); el('receive-overlay').textContent = '画面连接中断，正在尝试恢复…'; }
      clearTimeout(mediaFailureTimer);
      mediaFailureTimer = setTimeout(() => { if (pc === connection) recoverMedia('画面连接未能自动恢复'); }, 15000);
    } else if (connectionState === 'failed') recoverMedia('画面连接失败');
  };
  return connection;
}
async function flushICE(connection: RTCPeerConnection): Promise<void> {
  const queued = pendingICE;
  pendingICE = [];
  for (const candidate of queued) { if (pc !== connection) return; await connection.addIceCandidate(candidate); }
}
async function onSignal(signal: Signal): Promise<void> {
  if (!paired()) return;
  if (signal.type === 'media') {
    if (!receiverState()) return;
    if (signal.state === 'stopped') {
      transition('receiver-paired');
      receiverWaitingForMedia('对方已停止画面，等待重新选择…');
      status('设备仍已配对 · 等待重新投屏');
    } else {
      transition('receiver-paired');
      show('waiting-panel', false);
      show('receive-stage');
      show('receive-overlay');
      el('receive-overlay').textContent = '正在恢复画面…';
      el('receive-title').textContent = '等待画面';
      if (remoteStream) attachRemote(remoteStream);
    }
    return;
  }
  if (signal.type === 'reset') {
    if (!receiverState()) return;
    closePeer();
    transition('receiver-paired');
    receiverWaitingForMedia('正在重新建立画面连接…');
    return;
  }
  if (signal.type === 'ice') {
    if (!pc?.remoteDescription) { if (pendingICE.length < 128) pendingICE.push(signal.candidate); return; }
    await pc.addIceCandidate(signal.candidate);
    return;
  }
  if (signal.type === 'offer' && receiverState()) {
    const connection = ensurePeer();
    await connection.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    await flushICE(connection);
    if (pc !== connection) return;
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (pc === connection) await api.signal({ type: 'answer', sdp: answer.sdp! });
  } else if (signal.type === 'answer' && senderState() && pc) {
    const connection = pc;
    await connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    await flushICE(connection);
  }
}

async function startOrSwitchShare(): Promise<void> {
  if (!chosen || !['sender-ready', 'sender-sharing'].includes(state)) return;
  const stamp = ++mediaEpoch;
  const priorStream = media;
  const priorTrack = priorStream?.getVideoTracks()[0];
  let nextStream: MediaStream | undefined;
  try {
    await api.selectSource(chosen.id);
    const quality = qualitySettings();
    nextStream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { width: { ideal: quality.width, max: quality.width }, height: { ideal: quality.height, max: quality.height }, frameRate: { ideal: 30, max: 30 } }
    });
    if (stamp !== mediaEpoch || !senderState()) { nextStream.getTracks().forEach(track => track.stop()); return; }
    for (const track of nextStream.getAudioTracks()) { track.stop(); nextStream.removeTrack(track); }
    const nextTrack = nextStream.getVideoTracks()[0];
    if (!nextTrack) throw new Error('未取得可分享的画面');

    let connection = pc;
    if (!connection || !senderTransceiver || ['closed', 'failed'].includes(connection.connectionState)) {
      closePeer();
      await api.signal({ type: 'reset' });
      connection = ensurePeer();
      senderTransceiver = connection.addTransceiver(nextTrack, {
        direction: 'sendonly', streams: [nextStream], sendEncodings: [{ maxBitrate: quality.bitrate, maxFramerate: 30 }]
      });
      await configureSender(nextTrack, senderTransceiver);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (pc !== connection) throw new Error('画面连接已取消');
      await api.signal({ type: 'offer', sdp: offer.sdp! });
    } else {
      await senderTransceiver.sender.replaceTrack(nextTrack);
      await configureSender(nextTrack, senderTransceiver);
    }

    media = nextStream;
    nextStream = undefined;
    nextTrack.onended = () => { if (media?.getVideoTracks()[0] === nextTrack) void stopSharing('所选窗口已关闭，已停止画面'); };
    el<HTMLVideoElement>('local-video').srcObject = media;
    el('source-name').textContent = chosen.name;
    if (priorTrack && priorTrack !== nextTrack) { priorTrack.onended = null; priorStream!.getTracks().forEach(track => track.stop()); }
    await sendSignal({ type: 'media', state: 'started' });
    transition('sender-sharing');
    show('source-panel', false);
    show('sharing-panel');
    show('cancel-change', false);
    status(priorStream ? '画面已切换，配对连接保持不变' : '正在建立画面连接…', 'busy');
  } catch (error) {
    nextStream?.getTracks().forEach(track => track.stop());
    if (priorStream) {
      media = priorStream;
      transition('sender-sharing');
      show('source-panel', false);
      show('sharing-panel');
    } else {
      stopCapture();
      closePeer();
      transition('sender-ready');
      senderReadyUI();
    }
    throw error;
  }
}
async function stopSharing(reason = '画面已停止，与大屏仍保持配对'): Promise<void> {
  mediaEpoch++;
  try { await senderTransceiver?.sender.replaceTrack(null); } catch { /* A failed peer will be rebuilt on the next start. */ }
  stopCapture();
  await sendSignal({ type: 'media', state: 'stopped' });
  if (state !== 'sender-reconnecting') transition('sender-ready');
  senderReadyUI();
  status(reason);
  await refreshSources();
}
async function disconnectSender(): Promise<void> {
  sessionEpoch++;
  cleanupSessionMedia();
  await api.stop();
  transition('sender-disconnected');
  senderDisconnectedUI();
  status('已断开大屏');
}
async function connectSender(connect: () => Promise<void>): Promise<void> {
  const stamp = ++sessionEpoch;
  transition('sender-connecting');
  status('已找到大屏，等待接收端允许…', 'busy');
  try {
    await connect();
    if (stamp !== sessionEpoch) return;
    transition('sender-ready');
    senderReadyUI();
    status('已连接 · 请选择分享内容');
    await refreshSources();
  } catch (error) {
    if (stamp === sessionEpoch) { transition('sender-disconnected'); senderDisconnectedUI(); }
    throw error;
  }
}
async function failApplication(error: unknown): Promise<void> {
  sessionEpoch++;
  cleanupSessionMedia();
  await api.stop();
  transition('home');
  view('home');
  status('连接服务已结束', 'error');
  message(error);
}

api.onEvent((event: AppEvent) => {
  if (event.type === 'invite') updateInfo(event.info);
  if (event.type === 'fullscreen') document.body.dataset.fullscreen = String(event.enabled);
  if (event.type === 'pair-request' && receiverState()) {
    currentPairId = event.id;
    el('pair-name').textContent = event.name;
    el('pair-address').textContent = `来自 ${event.address}，是否允许这台电脑投屏？`;
    show('pair-request');
    status('收到新的投屏请求', 'busy');
  }
  if (event.type === 'pair-request-ended' && event.id === currentPairId) {
    currentPairId = undefined;
    show('pair-request', false);
  }
  if (event.type === 'peer-joined' && receiverState()) {
    currentPairId = undefined;
    show('pair-request', false);
    el<HTMLInputElement>('auto-approve').checked = false;
    transition('receiver-paired');
    receiverWaitingForMedia('已配对，等待对方选择分享内容…');
    status('已配对 · 等待对方开始投屏', 'busy');
  }
  if (event.type === 'peer-reconnecting') {
    if (senderState()) transition('sender-reconnecting');
    else if (receiverState()) transition('receiver-reconnecting');
    status(event.reason, 'busy');
    if (receiverState()) { show('receive-overlay'); el('receive-overlay').textContent = event.reason; }
    renderSources();
  }
  if (event.type === 'peer-rejoined') {
    if (senderState()) {
      transition(media ? 'sender-sharing' : 'sender-ready');
      void sendSignal({ type: 'media', state: media ? 'started' : 'stopped' });
      status(media ? '连接已恢复 · 正在分享画面' : '连接已恢复 · 可开始投屏');
    } else if (receiverState()) {
      transition(remoteStream ? 'receiver-playing' : 'receiver-paired');
      if (remoteStream) attachRemote(remoteStream);
      else receiverWaitingForMedia('连接已恢复，等待对方画面…');
      status('与原电脑的连接已恢复');
    }
    renderSources();
  }
  if (event.type === 'signal') {
    const stamp = sessionEpoch;
    signalQueue = signalQueue.then(async () => { if (stamp === sessionEpoch) await onSignal(event.signal); }).catch(error => {
      if (stamp === sessionEpoch) recoverMedia(error instanceof Error ? error.message : '画面协商失败');
    });
  }
  if (event.type === 'peer-left') {
    sessionEpoch++;
    cleanupSessionMedia();
    if (receiverState()) {
      currentPairId = undefined;
      show('pair-request', false);
      transition('receiver-listening');
      show('receive-stage', false);
      show('waiting-panel');
      el('receive-title').textContent = '准备接收画面';
    } else if (senderState()) {
      transition('sender-disconnected');
      senderDisconnectedUI();
    }
    status(event.reason);
  }
  if (event.type === 'error') void failApplication(event.message);
});

bind('go-send', async () => {
  sessionEpoch++;
  await api.stop();
  cleanupSessionMedia();
  transition('sender-disconnected');
  senderDisconnectedUI();
  view('send');
  status('正在查找附近的大屏…', 'busy');
  await scanDevices();
});
bind('go-receive', async () => {
  const stamp = ++sessionEpoch;
  cleanupSessionMedia();
  transition('receiver-listening');
  status('正在准备接收…', 'busy');
  const result = await api.receive();
  if (stamp !== sessionEpoch) return;
  updateInfo(result);
  view('receive');
  show('waiting-panel');
  show('receive-stage', false);
  status('接收已就绪 · 等待连接');
  const firewall = await api.firewallStatus();
  if (stamp === sessionEpoch) show('firewall-card', firewall.supported && !firewall.configured);
});
bind('connect', async () => {
  await connectSender(() => api.connect(el<HTMLTextAreaElement>('invitation').value));
});
bind('refresh-devices', scanDevices);
bind('connect-address', async () => { await connectSender(() => api.connectAddress(el<HTMLInputElement>('receiver-address').value)); });
bind('repair-firewall', async () => {
  status('请在 Windows 管理员确认窗口中选择“是”…', 'busy');
  const result = await api.repairFirewall();
  show('firewall-card', !result.configured);
  status(result.configured ? '防火墙已配置 · 接收已就绪' : result.message, result.configured ? 'ready' : 'error');
});
bind('allow-pair', async () => {
  const id = currentPairId;
  if (!id) return;
  await api.respondPair(id, true);
});
bind('reject-pair', async () => {
  const id = currentPairId;
  if (!id) return;
  await api.respondPair(id, false);
});
el<HTMLInputElement>('auto-approve').addEventListener('change', () => {
  const enabled = el<HTMLInputElement>('auto-approve').checked;
  void api.autoApproveNext(enabled).then(() => status(enabled ? '将自动允许下一台电脑（仅本次）' : '新设备需要在大屏上确认')).catch(error => {
    el<HTMLInputElement>('auto-approve').checked = false;
    message(error);
  });
});
bind('open-invite', async () => { const value = await api.openInvite(); if (value) el<HTMLTextAreaElement>('invitation').value = value; });
bind('copy-invite', async () => { await api.copy(invitation()); status('连接信息已复制，请粘贴到专家笔记本'); });
bind('save-invite', async () => { if (await api.saveInvite(invitation())) status('连接文件已保存，可通过 U 盘交给分享者'); });
bind('refresh-sources', refreshSources);
bind('start-share', startOrSwitchShare);
bind('change-source', async () => {
  show('sharing-panel', false);
  show('source-panel');
  show('cancel-change');
  status('当前画面继续投屏；选择新画面后点击“切换画面”');
  await refreshSources();
});
bind('cancel-change', async () => { show('source-panel', false); show('sharing-panel'); show('cancel-change', false); });
bind('stop-share', () => stopSharing());
bind('disconnect-send', disconnectSender);
bind('stop-receive', async () => {
  sessionEpoch++;
  cleanupSessionMedia();
  await api.stop();
  transition('home');
  view('home');
  status('接收已结束');
});
bind('fullscreen', async () => { document.body.dataset.fullscreen = String(await api.fullscreen()); });
for (const back of document.querySelectorAll<HTMLButtonElement>('.back')) back.addEventListener('click', async () => {
  sessionEpoch++;
  cleanupSessionMedia();
  await api.stop();
  transition('home');
  view('home');
  status('准备就绪');
});
window.addEventListener('beforeunload', cleanupSessionMedia);
void api.version().then(version => { el('version').textContent = `v${version} · 预览版`; });
