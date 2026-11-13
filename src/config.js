// Chargement de la configuration : fichier .env local (facultatif) puis variables d'environnement,
// puis réglages enregistrés depuis l'interface (Réglages), qui ont le dernier mot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Numéro de version unique : celui de package.json
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

// Lecture minimale d'un .env (KEY=VALUE, commentaires #)
function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const bool = (v) => String(v).toLowerCase() === 'true';
const num = (v, def) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Dossier de données par défaut : celui de l'application s'il existe déjà (installations existantes),
// sinon le dossier de l'utilisateur, pour qu'une mise à jour de l'application n'efface rien.
export function defaultDataDir(env = process.env) {
  const legacy = path.join(APP_ROOT, 'data');
  if (fs.existsSync(path.join(legacy, 'db.json'))) return legacy;
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CapsuleStudio');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CapsuleStudio');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'capsule-studio');
}

// Réglages modifiables depuis l'interface (stockés dans db.settings) ; null = valeur du .env ou par défaut
export const SETTING_KEYS = ['fishApiKey', 'allowPaid', 'paidBudgetTotalUsd', 'paidMaxPerRequestUsd', 'enableDrama3', 'maxGenerationsPerDay', 'freeOfferEndDate', 'lan'];

// Applique les réglages enregistrés par-dessus la configuration de base (fichier .env / défauts)
export function applySettings(config, settings = {}) {
  const base = config.base;
  const pick = (k) => (settings[k] === null || settings[k] === undefined ? base[k] : settings[k]);
  for (const k of SETTING_KEYS) {
    if (k === 'freeOfferEndDate') config.freeOffer = { ...config.freeOffer, endDate: pick(k) };
    else config[k] = pick(k);
  }
  return config;
}

// overrides : utilisé par les tests pour injecter une configuration complète
export function loadConfig(overrides = {}) {
  const env = { ...readDotEnv(path.join(APP_ROOT, '.env')), ...process.env, ...overrides };
  const dataDir = env.DATA_DIR ? path.resolve(APP_ROOT, env.DATA_DIR) : defaultDataDir(env);
  // Valeurs de base des réglages modifiables (avant réglages enregistrés)
  const base = Object.freeze({
    fishApiKey: env.FISH_API_KEY || '',
    allowPaid: bool(env.ALLOW_PAID_GENERATION),
    paidBudgetTotalUsd: num(env.PAID_BUDGET_TOTAL_USD, null),
    paidMaxPerRequestUsd: num(env.PAID_MAX_PER_REQUEST_USD, null),
    enableDrama3: bool(env.ENABLE_DRAMA3),
    maxGenerationsPerDay: num(env.MAX_GENERATIONS_PER_DAY, 999),
    freeOfferEndDate: env.FREE_OFFER_END_DATE || '2026-11-30',
    lan: bool(env.LAN)
  });
  const config = {
    agentTokenEnv: env.CAPSULE_AGENT_TOKEN || '',
    // Étiquette facultative affichée à côté du nom (ex. « Montage · dev » pour une copie de développement)
    instanceLabel: String(env.APP_LABEL || '').slice(0, 40),
    // Écoute sur l'interface loopback (accès réseau local : second serveur HTTPS, voir lan)
    host: '127.0.0.1',
    port: num(env.PORT, 8746),
    // Accès depuis les autres postes du réseau local : HTTPS sur le port PORT + 100
    lanPort: num(env.LAN_PORT, num(env.PORT, 8746) + 100),
    dataDir,
    audioDir: path.join(dataDir, 'audio'),
    freeOffer: {
      endDate: base.freeOfferEndDate,
      timezone: env.FREE_OFFER_TIMEZONE || 'Europe/Paris',
      verifiedAt: env.FREE_OFFER_VERIFIED_AT || '2026-10-22',
      sourceUrl: 'https://fish.audio/blog/s2-1-pro-free-api'
    },
    maxBytesPerSegment: num(env.MAX_BYTES_PER_SEGMENT, 5000),
    maxTakesPerBatch: 3,
    approvalTtlMs: 30 * 60 * 1000,
    providerTimeoutMs: num(env.PROVIDER_TIMEOUT_MS, 120000)
  };
  Object.defineProperty(config, 'base', { value: base, enumerable: false });
  return applySettings(config, {});
}
