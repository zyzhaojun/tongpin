import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, powerSaveBlocker, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { Receiver, Sender } from './signaling';
import { discoverReceivers, probeReceiver, type FoundReceiver } from './discovery';
import { firewallStatus, repairFirewall } from './firewall';
import type { AppEvent, Signal } from '../shared/types';

app.setName('同屏');
app.commandLine.appendSwitch('disable-background-networking');
if (!app.isPackaged && process.env.TONGPIN_TEST_PROFILE) app.setPath('userData', process.env.TONGPIN_TEST_PROFILE);
let win: BrowserWindow;
let receiver: Receiver | undefined;
let sender: Sender | undefined;
let generation = 0;
let blocker: number | undefined;
let selectedSource: { id: string; expires: number } | undefined;
let discovered = new Map<string, FoundReceiver>();
const indexFile = join(__dirname, 'renderer', 'index.html');
const allowedURL = pathToFileURL(indexFile).href;

function keepAwake(enabled: boolean): void {
  if (enabled && blocker === undefined) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!enabled && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
function emit(event: AppEvent): void {
  if (event.type === 'peer-left') { keepAwake(false); selectedSource = undefined; }
  if (event.type === 'peer-joined') keepAwake(true);
  if (win && !win.isDestroyed()) win.webContents.send('tongpin:event', event);
}
async function stopCurrent(): Promise<void> {
  generation++;
  selectedSource = undefined;
  keepAwake(false);
  const oldReceiver = receiver;
  const oldSender = sender;
  receiver = undefined;
  sender = undefined;
  oldSender?.close();
  await oldReceiver?.close();
}

function handle(name: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(`tongpin:${name}`, (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame?.url !== allowedURL) throw new Error('不允许的调用来源');
    return fn(...args);
  });
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    title: '同屏', width: 1120, height: 820, minWidth: 820, minHeight: 680,
    backgroundColor: '#f4f6f5', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  win.removeMenu();
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = selectedSource;
    selectedSource = undefined;
    // The renderer deliberately selects a source immediately before calling
    // getDisplayMedia().  An IPC round trip can clear Chromium's transient
    // user-gesture bit, so the one-shot, five-second source ticket is the
    // authorization here instead of request.userGesture.
    if (request.frame !== win.webContents.mainFrame || request.audioRequested || !choice || choice.expires < Date.now() || !sender) {
      callback({}); return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(x => x.id === choice.id);
      if (!source) { callback({}); return; }
      callback({ video: source });
      keepAwake(true);
    } catch { callback({}); }
  });
  // Every UI asset is local. No CDN, telemetry or external renderer requests.
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') }));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { void stopCurrent(); });
  win.on('closed', () => { void stopCurrent(); });
  win.on('enter-full-screen', () => emit({ type: 'fullscreen', enabled: true }));
  win.on('leave-full-screen', () => emit({ type: 'fullscreen', enabled: false }));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      event.preventDefault();
      win.setFullScreen(false);
    }
  });
  handle('version', () => app.getVersion());
  handle('receive', async () => {
    await stopCurrent();
    const current = generation;
    const instance = new Receiver(event => { if (receiver === instance) emit(event); });
    receiver = instance;
    try {
      const info = await instance.start();
      if (current !== generation) throw new Error('操作已取消');
      if (!info.addresses.length) throw new Error('未检测到局域网地址，请先连接 Wi-Fi 或网线');
      return info;
    } catch (error) {
      if (receiver === instance) receiver = undefined;
      await instance.close();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('接收端口 48765 已被占用，请关闭其他接收中的同屏窗口');
      throw error;
    }
  });
  handle('connect', async (invitation: string) => {
    await stopCurrent();
    const current = generation;
    const instance = new Sender(event => { if (sender === instance) emit(event); });
    sender = instance;
    try { await instance.connect(invitation); if (current !== generation) throw new Error('操作已取消'); }
    catch (error) { instance.close(); if (sender === instance) sender = undefined; throw error; }
  });
  handle('discover', async () => {
    const results = await discoverReceivers();
    discovered = new Map(results.map(result => [result.device.id, result]));
    return results.map(result => result.device);
  });
  handle('connect-device', async (id: unknown) => {
    if (typeof id !== 'string' || id.length > 64) throw new Error('请选择有效的接收设备');
    const found = discovered.get(id);
    if (!found) throw new Error('设备信息已过期，请重新查找');
    await stopCurrent();
    const current = generation;
    const instance = new Sender(event => { if (sender === instance) emit(event); });
    sender = instance;
    try { await instance.connectDiscovered(found); if (current !== generation) throw new Error('操作已取消'); }
    catch (error) { instance.close(); if (sender === instance) sender = undefined; throw error; }
  });
  handle('connect-address', async (address: unknown) => {
    if (typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address.trim())) throw new Error('请输入接收端的 IPv4 地址');
    const found = await probeReceiver(address.trim(), 48765, 2000);
    if (!found) throw new Error('该地址没有找到正在接收的 Tongpin，请检查防火墙和接收状态');
    await stopCurrent();
    const current = generation;
    const instance = new Sender(event => { if (sender === instance) emit(event); });
    sender = instance;
    try { await instance.connectDiscovered(found); if (current !== generation) throw new Error('操作已取消'); }
    catch (error) { instance.close(); if (sender === instance) sender = undefined; throw error; }
  });
  handle('respond-pair', (id: unknown, allow: unknown) => {
    if (!receiver || typeof id !== 'string' || typeof allow !== 'boolean') throw new Error('连接请求无效');
    receiver.respondPair(id, allow);
  });
  handle('auto-approve-next', (enabled: unknown) => {
    if (!receiver || typeof enabled !== 'boolean') throw new Error('接收端尚未启动');
    receiver.setAutoApproveNext(enabled);
  });
  handle('firewall-status', firewallStatus);
  handle('repair-firewall', repairFirewall);
  handle('sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 180 }, fetchWindowIcons: false });
    return sources.filter(source => source.name !== win.getTitle()).map(source => ({ id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail.toDataURL() }));
  });
  handle('select-source', (id: unknown) => {
    if (!sender || typeof id !== 'string' || id.length > 200 || !/^(screen|window):/.test(id)) throw new Error('请先连接大屏，再选择分享内容');
    selectedSource = { id, expires: Date.now() + 5000 };
  });
  handle('signal', (message: Signal) => {
    if (receiver) receiver.send(message);
    else if (sender) sender.send(message);
    else throw new Error('当前未连接设备');
  });
  handle('stop', stopCurrent);
  handle('fullscreen', () => {
    const enabled = !win.isFullScreen();
    win.setFullScreen(enabled);
    return enabled;
  });
  handle('copy', (text: unknown) => { if (typeof text !== 'string' || text.length > 2048) throw new Error('内容无效'); clipboard.writeText(text); });
  handle('save-invite', async (text: unknown) => {
    if (typeof text !== 'string' || text.length > 2048 || !text.startsWith('tongpin://')) throw new Error('连接信息无效');
    const result = await dialog.showSaveDialog(win, { title: '保存连接信息', defaultPath: '大屏连接.tongpin', filters: [{ name: '同屏连接信息', extensions: ['tongpin'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
    return true;
  });
  handle('open-invite', async () => {
    const result = await dialog.showOpenDialog(win, { title: '打开连接信息', properties: ['openFile'], filters: [{ name: '同屏连接信息', extensions: ['tongpin', 'txt'] }] });
    if (result.canceled) return null;
    const data = await readFile(result.filePaths[0]);
    if (data.length > 2048) throw new Error('连接文件内容过长');
    return data.toString('utf8');
  });
  void win.loadFile(indexFile);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { void stopCurrent(); });
