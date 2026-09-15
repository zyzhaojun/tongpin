import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FirewallStatus } from '../shared/types';

const execFileAsync = promisify(execFile);
export const FIREWALL_RULE = 'Tongpin-LAN-TCP-48765';
const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function firewallInstallScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    `Get-NetFirewallRule -Name '${FIREWALL_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -Name '${FIREWALL_RULE}' -DisplayName '同屏 - 局域网接收' -Description '允许同一局域网中的 Tongpin 发送端连接 TCP 48765' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort 48765 -RemoteAddress LocalSubnet | Out-Null`
  ].join('; ');
}

export async function firewallStatus(): Promise<FirewallStatus> {
  if (process.platform !== 'win32') return { supported: false, configured: true, message: '当前系统无需 Windows 防火墙规则' };
  const script = `$rule=Get-NetFirewallRule -Name '${FIREWALL_RULE}' -PolicyStore ActiveStore -ErrorAction SilentlyContinue; $port=$rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue; $address=$rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue; if($rule -and $rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and $port.Protocol -eq 'TCP' -and $port.LocalPort -eq '48765' -and $address.RemoteAddress -contains 'LocalSubnet'){'configured'}else{'missing'}`;
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { windowsHide: true, timeout: 8000 });
    const configured = stdout.includes('configured');
    return {
      supported: true,
      configured,
      message: configured ? '局域网接收规则已配置' : 'Windows 防火墙尚未配置 Tongpin 接收规则'
    };
  } catch {
    return { supported: true, configured: false, message: '无法确认 Windows 防火墙状态' };
  }
}

export async function repairFirewall(): Promise<FirewallStatus> {
  if (process.platform !== 'win32') return firewallStatus();
  const inner = encoded(firewallInstallScript());
  const quotedPath = powershell.replaceAll("'", "''");
  const outer = `$p=Start-Process -FilePath '${quotedPath}' -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}'; exit $p.ExitCode`;
  try {
    await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outer)], { windowsHide: true, timeout: 120000 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') throw new Error('防火墙修复等待超时，请重新点击并完成 Windows 管理员确认');
    throw new Error('未能修改防火墙；请在 Windows 管理员确认窗口中选择“是”后重试');
  }
  const status = await firewallStatus();
  if (!status.configured) throw new Error('防火墙规则未生效，请联系机房管理员检查组策略');
  return status;
}
