import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('build/renderer', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'build/main.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external', sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'build/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/main/signaling.ts'], outfile: 'build/signaling.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' }),
  build({ entryPoints: ['src/main/discovery.ts'], outfile: 'build/discovery.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' }),
  build({ entryPoints: ['src/main/firewall.ts'], outfile: 'build/firewall.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' }),
  build({ entryPoints: ['src/renderer/app.ts'], outfile: 'build/renderer/app.js', bundle: true, platform: 'browser', target: 'es2022' }),
  copyFile('src/renderer/index.html', 'build/renderer/index.html'),
  copyFile('src/renderer/style.css', 'build/renderer/style.css'),
  copyFile('src/renderer/enhancements.css', 'build/renderer/enhancements.css')
]);
console.log('Built Tongpin.');
