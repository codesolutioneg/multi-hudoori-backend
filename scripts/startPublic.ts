/**
 * Starts backend + Cloudflare quick tunnel (HTTPS, works from any mobile network).
 * Writes public URL to biotime_app/web/tunnel-url.json for the deployed website.
 *
 * Usage: npm run public
 *        npm run public -- --push   (also commit & push tunnel-url.json to GitHub)
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const backendRoot = path.resolve(__dirname, '..');
const tunnelJsonPath = path.resolve(backendRoot, '../biotime_app/web/tunnel-url.json');
const shouldPush = process.argv.includes('--push');

let tunnelUrl: string | null = null;
let devProc: ChildProcess | null = null;
let tunnelProc: ChildProcess | null = null;

function saveTunnelUrl(url: string) {
  if (tunnelUrl === url) return;
  tunnelUrl = url;
  const payload = {
    apiUrl: url,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(tunnelJsonPath), { recursive: true });
  fs.writeFileSync(tunnelJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PUBLIC API URL — paste on login or share with testers       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${url.padEnd(58)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`Saved → ${tunnelJsonPath}`);

  if (shouldPush) {
    pushTunnelUrlToGitHub();
  } else {
    console.log('Tip: npm run public:deploy  — updates the live website default API URL\n');
  }
}

function parseTunnelUrl(text: string) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match) saveTunnelUrl(match[0]);
}

function pushTunnelUrlToGitHub() {
  const appDir = path.resolve(backendRoot, '../biotime_app');
  const run = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: appDir, shell: true, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed`))));
    });

  run('git', ['add', 'web/tunnel-url.json'])
    .then(() => run('git', ['commit', '-m', 'Update public API tunnel URL', '--allow-empty']))
    .then(() => run('git', ['push', 'origin', 'main']))
    .then(() => console.log('Pushed tunnel-url.json — GitHub Pages will redeploy in ~2 min.\n'))
    .catch((err) => console.warn('Git push skipped:', err.message));
}

function startDev() {
  console.log('Starting backend on 0.0.0.0:3000 ...');
  devProc = spawn('npm', ['run', 'dev'], {
    cwd: backendRoot,
    shell: true,
    stdio: 'inherit',
  });
}

function startTunnel() {
  console.log('Starting Cloudflare HTTPS tunnel (works on mobile data) ...');
  tunnelProc = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', 'http://localhost:3000'], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnelProc.stdout?.on('data', (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    parseTunnelUrl(text);
  });

  tunnelProc.stderr?.on('data', (buf) => {
    const text = buf.toString();
    process.stderr.write(text);
    parseTunnelUrl(text);
  });
}

function shutdown() {
  devProc?.kill();
  tunnelProc?.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startDev();
setTimeout(startTunnel, 3000);
