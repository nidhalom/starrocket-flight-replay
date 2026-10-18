// Headless Chrome/Edge smoke test: serves the repo, loads preview scenarios, fails on any console
// error/exception, and (with --shots) writes PNG screenshots to screenshots/.
// Usage: node tools/browser-check.mjs [--shots]     (set CHROME_PATH to override the browser)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.argv.includes('--shots');
const browser = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p));
if (!browser) { console.error('No Chrome/Edge found (set CHROME_PATH)'); process.exit(2); }

const shotDir = fileURLToPath(new URL('../screenshots/', import.meta.url));
mkdirSync(shotDir, { recursive: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), '8123'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const scenarios = [
  { name: 'simulation', q: 'scenario=sim&at=0.1' },
  { name: 'data-mode', q: 'scenario=data&at=0.55' },
  { name: 'compare', q: 'scenario=compare&at=0.5&view=overview' },
  { name: 'cinematic', q: 'scenario=sim&at=0.03&view=cinematic' },
];
let failed = false;
for (const sc of scenarios) {
  const out = join(shotDir, sc.name + '.png');
  const r = spawnSync(browser, [
    '--headless=new', '--no-first-run', `--user-data-dir=${join(tmpdir(), 'sr-prof-' + sc.name)}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=1440,900', '--virtual-time-budget=8000', '--enable-logging=stderr', '--v=0',
    `--screenshot=${out}`, `http://127.0.0.1:8123/index.html?${sc.q}`,
  ], { encoding: 'utf8', timeout: 90000 });
  const lines = `${r.stderr}\n${r.stdout}`.split('\n').filter((l) => /CONSOLE/.test(l) && !/DevTools|favicon/.test(l));
  const errors = lines.filter((l) => /error|exception|failed/i.test(l));
  const ok = existsSync(out) && statSync(out).size > 20000;
  console.log(`${sc.name}: screenshot ${ok ? 'ok' : 'MISSING'}, console errors: ${errors.length}`);
  errors.forEach((e) => console.log('   ' + e.trim()));
  if (!ok || errors.length) failed = true;
}
server.kill();
if (!shots) console.log('(screenshots were written to screenshots/ as a side effect)');
process.exit(failed ? 1 : 0);
