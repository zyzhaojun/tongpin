const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const apps = [];
const fixtureProcesses = [];
(async () => {
  await fs.mkdir(results, { recursive: true });
  const profiles = await fs.mkdtemp(path.join(os.tmpdir(), 'tongpin-e2e-'));
  const errors = [];
  const checkpoints = [];
  async function launch(name) {
    const env = { ...process.env, TONGPIN_TEST_PROFILE: path.join(profiles, name) };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: root, env, timeout: 60000 });
    apps.push(app);
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') console.log('renderer:', msg.text()); });
    await expect(page.locator('#go-send')).toBeVisible();
    return { app, page };
  }
  const receiver = await launch('receiver');
  await receiver.page.screenshot({ path: path.join(results, '01-home.png') });
  checkpoints.push('home UI rendered');
  await expect(receiver.page.locator('#version')).toContainText('v0.2.1');
  // Validate the sandbox from the actual shipped preload environment.
  assert.equal(await receiver.page.evaluate(() => typeof window.require), 'undefined');
  await receiver.page.locator('#go-receive').click();
  await expect(receiver.page.locator('#receiver-invite')).toHaveValue(/^tongpin:\/\//, { timeout: 20000 });
  const invitation = await receiver.page.locator('#receiver-invite').inputValue();
  await receiver.page.screenshot({ path: path.join(results, '02-receiving.png'), mask: [receiver.page.locator('#receiver-invite'), receiver.page.locator('#address'), receiver.page.locator('#receiver-name')] });
  checkpoints.push('receiver started TLS service and generated invite');
  const sender = await launch('sender');
  await sender.page.locator('#go-send').click();
  await expect(sender.page.locator('#connect-card')).toBeVisible();
  await sender.page.screenshot({ path: path.join(results, '02a-nearby-devices.png') });
  await sender.page.locator('#receiver-address').fill('127.0.0.1');
  await sender.page.locator('#connect-address').click();
  await expect(receiver.page.locator('#pair-request')).toBeVisible({ timeout: 10000 });
  await expect(receiver.page.locator('#pair-name')).not.toBeEmpty();
  await receiver.page.screenshot({ path: path.join(results, '02b-pair-request.png'), mask: [receiver.page.locator('#receiver-name'), receiver.page.locator('#address'), receiver.page.locator('#pair-name'), receiver.page.locator('#pair-address')] });
  await receiver.page.locator('#allow-pair').click();
  await expect(sender.page.locator('#source-panel')).toBeVisible({ timeout: 15000 });
  checkpoints.push('IP discovery connected without transferring a secret; receiver approval succeeded');

  await sender.page.locator('#disconnect-send').click();
  await expect(receiver.page.locator('#waiting-panel')).toBeVisible({ timeout: 10000 });
  const invitationAfterDiscovery = await receiver.page.locator('#receiver-invite').inputValue();
  assert.notEqual(invitationAfterDiscovery, invitation);

  await sender.page.locator('.manual-connect').first().locator('summary').click();
  await sender.page.locator('#invitation').fill('not-a-valid-invitation');
  await sender.page.locator('#connect').click();
  await expect(sender.page.locator('#notice')).toContainText('格式不正确');
  await sender.page.locator('#invitation').fill(invitationAfterDiscovery);
  await sender.page.locator('#connect').click();
  await expect(sender.page.locator('#source-panel')).toBeVisible({ timeout: 15000 });
  await expect(receiver.page.locator('#receive-overlay')).toContainText('等待对方');
  checkpoints.push('UI pairing succeeded; invalid invitation rejected');
  const fixtureProcess = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/fixtures/capture-window.ps1')], { stdio: 'ignore' });
  fixtureProcesses.push(fixtureProcess);
  await sender.page.waitForTimeout(800);
  await sender.page.locator('#source-kind').selectOption('window');
  await sender.page.locator('#refresh-sources').click();
  const source = sender.page.getByRole('button', { name: 'Tongpin Capture Test', exact: true });
  await expect(source).toBeVisible({ timeout: 10000 });
  await source.click();
  await sender.page.locator('#start-share').click();
  await expect(sender.page.locator('#sharing-panel')).toBeVisible({ timeout: 15000 });
  await expect(receiver.page.locator('#receive-title')).toHaveText('正在接收画面', { timeout: 20000 });
  const localTracks = await sender.page.evaluate(() => {
    const stream = document.getElementById('local-video').srcObject;
    return stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }));
  });
  assert.deepEqual(localTracks, [{ kind: 'video', state: 'live' }]);
  const before = await receiver.page.evaluate(() => document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames);
  await receiver.page.waitForTimeout(3000);
  const after = await receiver.page.evaluate(() => {
    const video = document.getElementById('remote-video');
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    const rgb = [...ctx.getImageData(15, 60, 1, 1).data];
    return { frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth, height: video.videoHeight, audioTracks: video.srcObject.getAudioTracks().length, rgb };
  });
  assert.ok(after.frames > before + 5, `video did not advance: ${before} -> ${after.frames}`);
  assert.ok(after.width > 400 && after.height > 200);
  assert.equal(after.audioTracks, 0);
  assert.ok(after.rgb[1] > after.rgb[0] + 25, `capture expected a green test window, got ${after.rgb}`);
  const originalRemoteTrack = await receiver.page.evaluate(() => document.getElementById('remote-video').srcObject.getVideoTracks()[0].id);
  await receiver.page.screenshot({ path: path.join(results, '03-live-receiving.png') });
  checkpoints.push(`actual window capture decoded: ${after.width}x${after.height}, frames ${before}->${after.frames}, zero audio tracks`);
  const pressReceiverKey = keyCode => receiver.app.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }, keyCode);
  await pressReceiverKey('F11');
  await expect.poll(() => receiver.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await expect.poll(() => receiver.page.evaluate(() => document.body.dataset.fullscreen)).toBe('true');
  const fullscreenLayout = await receiver.page.evaluate(() => {
    const stage = document.getElementById('receive-stage').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
      topbar: getComputedStyle(document.querySelector('.topbar')).display,
      footer: getComputedStyle(document.querySelector('footer')).display,
      title: getComputedStyle(document.querySelector('.page-title')).display
    };
  });
  assert.deepEqual([fullscreenLayout.topbar, fullscreenLayout.footer, fullscreenLayout.title], ['none', 'none', 'none']);
  assert.ok(Math.abs(fullscreenLayout.stage.x) <= 1 && Math.abs(fullscreenLayout.stage.y) <= 1);
  assert.ok(Math.abs(fullscreenLayout.stage.width - fullscreenLayout.viewport.width) <= 1);
  assert.ok(Math.abs(fullscreenLayout.stage.height - fullscreenLayout.viewport.height) <= 1);
  await receiver.page.screenshot({ path: path.join(results, '04-true-fullscreen.png') });
  await pressReceiverKey('Escape');
  await expect.poll(() => receiver.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  await expect.poll(() => receiver.page.evaluate(() => document.body.dataset.fullscreen)).toBe('false');
  await receiver.page.locator('#fullscreen').click();
  await expect.poll(() => receiver.page.evaluate(() => document.body.dataset.fullscreen)).toBe('true');
  await pressReceiverKey('Escape');
  await expect.poll(() => receiver.page.evaluate(() => document.body.dataset.fullscreen)).toBe('false');
  checkpoints.push('F11 and the full-screen button filled the viewport; Escape exited both paths');

  await sender.page.locator('#change-source').click();
  await expect(sender.page.locator('#source-panel')).toBeVisible();
  await sender.page.locator('#quality').selectOption('720');
  await expect(sender.page.locator('#status-text')).toContainText('画质已调整为 720p');
  await sender.page.getByRole('button', { name: 'Tongpin Capture Test', exact: true }).click();
  await sender.page.locator('#start-share').click();
  await expect(sender.page.locator('#sharing-panel')).toBeVisible();
  await expect(receiver.page.locator('#receive-title')).toHaveText('正在接收画面', { timeout: 15000 });
  const switchedRemoteTrack = await receiver.page.evaluate(() => document.getElementById('remote-video').srcObject.getVideoTracks()[0].id);
  assert.equal(switchedRemoteTrack, originalRemoteTrack, 'source switch renegotiated instead of replacing the existing track');
  assert.equal(await receiver.page.locator('#receiver-invite').inputValue(), invitationAfterDiscovery);
  checkpoints.push('quality update and source switch kept the paired session and existing remote track');

  await sender.page.locator('#stop-share').click();
  await expect(receiver.page.locator('#receive-overlay')).toContainText('已停止画面', { timeout: 10000 });
  await expect(sender.page.locator('#source-panel')).toBeVisible();
  await expect(sender.page.locator('#connect-card')).toBeHidden();
  assert.equal(await sender.page.evaluate(() => document.getElementById('local-video').srcObject), null);
  assert.equal(await receiver.page.evaluate(() => document.getElementById('remote-video').srcObject), null);
  assert.equal(await receiver.page.locator('#receiver-invite').inputValue(), invitationAfterDiscovery);
  checkpoints.push('fullscreen/ESC and stop-media cleanup kept the pairing alive');

  await sender.page.getByRole('button', { name: 'Tongpin Capture Test', exact: true }).click();
  await sender.page.locator('#start-share').click();
  await expect(receiver.page.locator('#receive-title')).toHaveText('正在接收画面', { timeout: 15000 });
  await sender.page.locator('#stop-share').click();
  await sender.page.locator('#disconnect-send').click();
  await expect(receiver.page.locator('#waiting-panel')).toBeVisible({ timeout: 10000 });
  await expect(sender.page.locator('#connect-card')).toBeVisible();
  const replacement = await receiver.page.locator('#receiver-invite').inputValue();
  assert.notEqual(replacement, invitationAfterDiscovery);
  checkpoints.push('a second share reused the pairing; explicit disconnect rotated the invitation');

  await sender.page.locator('#invitation').fill(replacement);
  await sender.page.locator('#connect').click();
  await expect(sender.page.locator('#source-panel')).toBeVisible({ timeout: 15000 });
  await receiver.page.locator('#stop-receive').click();
  await expect(sender.page.locator('#connect-card')).toBeVisible({ timeout: 10000 });
  checkpoints.push('second pairing and receiver shutdown passed');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(results, 'app-test.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), scope: 'Two Electron processes on one Windows computer; IP discovery, receiver approval, real window capture and local WebRTC. Version 0.2.1 full-screen behavior still requires a physical display retest.', checkpoints, media: after, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checkpoints, media: after }, null, 2));
})().catch(async error => {
  console.error(error);
  for (let i = 0; i < apps.length; i++) {
    try { const pages = await apps[i].windows(); console.error('App', i, await pages[0].locator('body').innerText()); await pages[0].screenshot({ path: path.join(results, `failure-${i}.png`), mask: [pages[0].locator('#receiver-invite'), pages[0].locator('#invitation')] }); } catch {}
  }
  process.exitCode = 1;
}).finally(async () => {
  for (const app of apps.reverse()) { try { await app.close(); } catch {} }
  for (const process of fixtureProcesses) { try { process.kill(); } catch {} }
});
