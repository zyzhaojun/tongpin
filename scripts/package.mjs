import { packager } from '@electron/packager';
import { readFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve('.');
const out = resolve(root, 'release');
if (!out.startsWith(root + '\\') && !out.startsWith(root + '/')) throw new Error('Invalid release directory');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(out, { recursive: true });
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'make-icon.ps1')], { stdio: 'inherit' });
const paths = await packager({
  dir: root, name: 'Tongpin', executableName: 'Tongpin', platform: 'win32', arch: 'x64',
  electronVersion: pkg.devDependencies.electron, out, overwrite: true,
  asar: true, prune: true, icon: join(root, 'assets', 'icon.ico'),
  appVersion: pkg.version,
  ...(existsSync(join(root, '.cache', 'electron', `electron-v${pkg.devDependencies.electron}-win32-x64.zip`)) ? { electronZipDir: join(root, '.cache', 'electron') } : {}),
  ignore: [/^\/(src|tests|test-results|scripts|docs|release|\.git|\.cache)(\/|$)/, /^\/build\/(signaling|discovery|firewall)\.cjs$/, /^\/build\/.*\.map$/, /^\/tsconfig\.json$/, /^\/package-lock\.json$/],
  win32metadata: { CompanyName: 'Tongpin', FileDescription: '同屏 · 局域网画面投屏', ProductName: '同屏', InternalName: 'Tongpin' }
});
const appDir = paths[0];
await copyFile('docs/使用说明.md', join(appDir, '使用说明.txt'));
const zip = join(out, `Tongpin-${pkg.version}-win-x64.zip`);
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'zip-release.ps1'), '-SourcePath', appDir, '-DestinationPath', zip, '-ReleaseRoot', out], { stdio: 'inherit' });
const hash = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(zip + '.sha256', hash + '  ' + `Tongpin-${pkg.version}-win-x64.zip\n`);
console.log(JSON.stringify({ executable: join(appDir, 'Tongpin.exe'), zip, sha256: hash }, null, 2));
