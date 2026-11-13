// Capture d'écran réelle via Chrome headless + protocole DevTools (sans dépendance).
// Usage : node tests/tools/cdp-shot.js <url> <cookie> <sortie.png> [largeur] [hauteur] [script JS à exécuter avant]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, cookie, out, width = '1920', height = '1080', before = ''] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-chrome-'));
// IGNORE_CERT=1 : accepte le certificat auto-signé du réseau local (tests uniquement)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', ...(process.env.IGNORE_CERT ? ['--ignore-certificate-errors'] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* Chrome démarre */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Network.enable');
// Maquettes : permet d'injecter une feuille de style de test malgré la CSP
if (process.env.BYPASS_CSP) await send('Page.setBypassCSP', { enabled: true });
const u = new URL(url);
if (cookie) await send('Network.setCookie', { name: 'cs_session', value: cookie, domain: u.hostname, path: '/', httpOnly: true, sameSite: 'Strict' });
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(1500);
if (before) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${before} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) logs.push(`script ERREUR: ${r.result.exceptionDetails.exception?.description}`);
  if (r.result?.result?.value !== undefined) logs.push(`script: ${JSON.stringify(r.result.result.value)}`);
  await sleep(1200);
}
// Mesure du débordement horizontal
const ov = await send('Runtime.evaluate', { expression: 'JSON.stringify({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})', returnByValue: true });
logs.push(`layout: ${ov.result.result.value}`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(logs.join('\n'));
ws.close();
chrome.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profil temporaire verrouillé */ }
