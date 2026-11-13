// Point d'entrée : node server.js
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';

const config = loadConfig();

// Une seule instance (donc un seul worker) par dossier de données
fs.mkdirSync(config.dataDir, { recursive: true });
const lockFile = path.join(config.dataDir, 'server.lock');
if (fs.existsSync(lockFile)) {
  const pid = Number(fs.readFileSync(lockFile, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* processus disparu : verrou périmé */ }
  if (alive && pid !== process.pid) {
    console.error(`Capsule Studio tourne déjà (processus ${pid}) sur ce dossier de données. Un seul serveur à la fois.`);
    process.exit(1);
  }
}
fs.writeFileSync(lockFile, String(process.pid));
const releaseLock = () => { try { if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile); } catch { /* déjà libéré */ } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const app = createApp({ config });
try {
  const port = await app.listen();
  console.log(`Capsule Studio : http://127.0.0.1:${port}`);
  // Réseau local : adresses à ouvrir depuis les autres postes
  const lan = app.lan();
  if (lan.active) {
    console.log('Réseau local (autres postes) :');
    for (const u of lan.urls) console.log(`  ${u}`);
    console.log('  Certificat à installer sur ces postes : /capsule-studio-reseau.cer (voir Réglages)');
  } else if (lan.enabled) console.log(`Réseau local indisponible : ${lan.error}`);
  console.log(`Clé Fish Audio : ${config.fishApiKey ? 'configurée' : 'absente (à renseigner dans Réglages)'}`);
  console.log('Arrêt : Ctrl+C');
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} déjà utilisé.` : `Démarrage impossible (${e.code || 'erreur'}).`);
  process.exit(1);
}
