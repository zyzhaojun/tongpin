# Tongpin

[English](README.md) | [简体中文](README.zh-CN.md)

Peer-to-peer screen sharing for Windows local area networks. Tongpin is a portable desktop app with two simple modes: share your screen and receive a shared screen.

Current version: 0.2.1 preview. Tongpin shares video only and never captures system audio or a microphone. It requires no account, subscription, license check, automatic updater, or internet connection at runtime.

## Usage

Download `Tongpin-0.2.1-win-x64.zip` from [GitHub Releases](https://github.com/zyzhaojun/tongpin/releases/latest). Fully extract it on two Windows x64 computers, then run `Tongpin.exe` from each extracted folder. Node.js is not required.

1. On the display computer, select **接收投屏** (Receive Screen). The first time, select **一键修复** (One-click Fix) and approve the Windows administrator prompt.
2. On the laptop, select **我要投屏** (Share My Screen), choose the display from nearby devices, and approve the request on the display computer. You can also enter the display computer's IP address directly.
3. Choose the entire screen or an application window, then select **开始投屏** (Start Sharing).
4. On the receiver, press F11 to enter full screen and Esc to leave full screen.

The receiver can enable **自动允许下一台电脑（仅本次）** (Automatically allow the next computer, this session only) after confirming that the local network is trusted. This skips the approval prompt for only the next connection. The full invitation text and `.tongpin` file remain available as fallback options.

Stopping the video keeps the devices paired, so you can switch windows or start sharing again without reconnecting. Only **断开连接** (Disconnect) clears the pairing. Changing the quality or source also keeps the current pairing.

Detailed Chinese documentation is available in the [user guide](docs/使用说明.md), [development plan](docs/开发方案.md), and [validation record](docs/验证记录.md).

## Local development

Use Node.js 24 LTS or a newer compatible version. Installing dependencies and downloading Electron for the first time requires internet access; running the packaged app does not.

```powershell
npm ci
npm run check
npm test
npm run test:app
npm start
npm run package
```

`test:app` temporarily opens two app instances and a dedicated test window, then captures that test window. The test closes the instances automatically and writes its results and screenshots to `test-results/`.

## Architecture

- Electron and TypeScript provide the local interface and screen capture. A sandboxed preload script exposes a limited API.
- The receiver hosts an HTTPS/WSS service on TCP port 48765 by default. The sender probes the `/24` network for each local IPv4 address in parallel, without relying on mDNS or multicast that campus networks may filter.
- Discovery returns only the device name. The sender obtains the TLS certificate fingerprint directly, and the receiver must still approve the connection. Connection secrets are never broadcast on the LAN.
- The Windows Firewall helper creates a fixed inbound rule for TCP port 48765 restricted to `LocalSubnet`. The rule is independent of the executable path, so moving or upgrading the portable app does not invalidate it.
- The fallback invitation contains the receiver's IPv4 addresses, port, SHA-256 certificate fingerprint, and a random 128-bit token. The client verifies the fingerprint before sending the token and does not depend on a public certificate service.
- Pending invitations rotate every 10 minutes and after a manual disconnect or recovery timeout. The receiver accepts only one sender at a time.
- WebRTC uses local candidates only with `iceServers: []`. The sender publishes only a video track, and the receiver rejects audio SDP.
- Video prioritizes readable text and offers 1080p and 720p targets at up to 30 fps. Actual performance depends on the display, encoder, and network.
- WebSocket heartbeats detect connection loss. A separate 256-bit recovery credential reserves the session for the original device for 60 seconds. Media failures wait 15 seconds before rebuilding only the media connection while keeping the pairing channel alive.

## Current limitations

- Windows x64 is supported. See the validation record for the tested systems and scenarios.
- Automatic discovery scans the `/24` network for every IPv4 address on the sender. For devices on another subnet, enter the receiver's IP address manually; the network must still permit direct communication.
- Capturing an application window may pause when that window is minimized. For PowerPoint presentations, sharing the entire screen is recommended.
- Devices connected to the same Wi-Fi name are not necessarily allowed to communicate. Guest or campus network isolation can block the connection.
- Success on the tested devices does not guarantee compatibility with every computer or campus Wi-Fi environment.

## License

The source code is licensed under the MIT License. Electron, Chromium, and other dependencies retain their respective licenses, included with the dependencies or packaged distribution.
