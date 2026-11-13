// Construit le ZIP portable Windows : code de l'application + Node.js (runtime/node.exe).
// Usage : npm run release   → dist/capsule-studio-vX.Y.Z-windows.zip
// Aucune dépendance : téléchargement depuis nodejs.org, empreinte SHA-256 vérifiée, ZIP écrit par src/zip.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildZip, readZip } from '../src/zip.js';
import { APP_ROOT, APP_VERSION } from '../src/config.js';

// Version de Node livrée (testée avec l'application) : à monter ici lors d'une mise à jour de sécurité
const NODE_VERSION = '22.17.1';
const NODE_DIST = `node-v${NODE_VERSION}-win-x64`;
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

// Fichiers de l'application exclus du ZIP (outils de développement)
const EXCLUDE = [/^tests\//, /^tools\//, /^\.gitignore$/, /^\.gitattributes$/, /^\.github\//];

const distDir = path.join(APP_ROOT, 'dist');
const cacheDir = path.join(distDir, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Node.js pour Windows, mis en cache et vérifié contre SHASUMS256.txt
async function nodeZip() {
  const file = path.join(cacheDir, `${NODE_DIST}.zip`);
  const sums = (await download(`${NODE_BASE}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').find((l) => l.trim().endsWith(`${NODE_DIST}.zip`))?.split(/\s+/)[0];
  if (!expected) throw new Error('Empreinte de Node introuvable dans SHASUMS256.txt.');
  let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  if (!buf || sha(buf) !== expected) {
    console.log(`Téléchargement de Node ${NODE_VERSION}…`);
    buf = await download(`${NODE_BASE}/${NODE_DIST}.zip`);
    if (sha(buf) !== expected) throw new Error('Empreinte SHA-256 de Node incorrecte : archive refusée.');
    fs.writeFileSync(file, buf);
  }
  console.log(`Node ${NODE_VERSION} vérifié (SHA-256).`);
  return buf;
}

// Fichiers suivis par Git uniquement : rien de local (données, .env, sauvegardes) ne peut partir
function appFiles() {
  const list = execFileSync('git', ['ls-files', '-z'], { cwd: APP_ROOT }).toString('utf8').split('\0').filter(Boolean);
  return list.filter((f) => !EXCLUDE.some((re) => re.test(f)));
}

const root = `capsule-studio-v${APP_VERSION}`;
const entries = [];
for (const f of appFiles()) entries.push({ name: `${root}/${f}`, data: fs.readFileSync(path.join(APP_ROOT, f)) });
const node = readZip(await nodeZip(), (n) => n === `${NODE_DIST}/node.exe` || n === `${NODE_DIST}/LICENSE`);
if (!node[`${NODE_DIST}/node.exe`]) throw new Error('node.exe absent de l’archive Node.');
entries.push({ name: `${root}/runtime/node.exe`, data: node[`${NODE_DIST}/node.exe`] });
entries.push({ name: `${root}/runtime/LICENSE-node.txt`, data: node[`${NODE_DIST}/LICENSE`] });

const out = path.join(distDir, `capsule-studio-v${APP_VERSION}-windows.zip`);
const zip = buildZip(entries, { deflate: true });
fs.writeFileSync(out, zip);
const sum = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sum}  ${path.basename(out)}\n`);
console.log(`${path.relative(APP_ROOT, out)} : ${(zip.length / 1048576).toFixed(1)} Mo, ${entries.length} fichiers`);
console.log(`SHA-256 : ${sum}`);
