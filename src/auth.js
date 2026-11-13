// Authentification : un propriétaire (mot de passe haché scrypt, session cookie)
// et un jeton agent séparé, révocable, distinct de la clé Fish Audio.
import crypto from 'node:crypto';
import { registerSecret } from './redact.js';
import { AppError } from './services.js';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

export function createAuth(store, config) {
  if (config.agentTokenEnv) registerSecret(config.agentTokenEnv);
  const failures = new Map(); // limitation des tentatives de connexion

  return {
    ownerExists: () => Boolean(store.data.owner),

    setupOwner(password) {
      if (store.data.owner) throw new AppError(409, 'owner_exists', 'Propriétaire déjà configuré.');
      if (typeof password !== 'string' || password.length < 10) {
        throw new AppError(400, 'weak_password', 'Mot de passe : 10 caractères minimum.');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(password, salt, 64).toString('hex');
      store.tx((db) => { db.owner = { salt, hash, createdAt: new Date().toISOString() }; });
    },

    login(password, clientKey = 'local') {
      const f = failures.get(clientKey) ?? { count: 0, until: 0 };
      if (f.until > Date.now()) throw new AppError(429, 'too_many_attempts', 'Trop de tentatives, réessayez dans une minute.');
      const owner = store.data.owner;
      const ok = owner && typeof password === 'string'
        && safeEqualHex(crypto.scryptSync(password, owner.salt, 64).toString('hex'), owner.hash);
      if (!ok) {
        f.count++;
        if (f.count >= 5) { f.until = Date.now() + 60000; f.count = 0; }
        failures.set(clientKey, f);
        throw new AppError(401, 'bad_password', 'Mot de passe incorrect.');
      }
      failures.delete(clientKey);
      const token = crypto.randomBytes(32).toString('base64url');
      store.tx((db) => {
        // Purge des sessions expirées
        for (const [k, s] of Object.entries(db.sessions)) if (s.expiresAt < Date.now()) delete db.sessions[k];
        db.sessions[sha256(token)] = { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
      });
      return token;
    },

    logout(token) {
      if (token) store.tx((db) => { delete db.sessions[sha256(token)]; });
    },

    checkSession(token) {
      if (!token) return false;
      const s = store.data.sessions[sha256(token)];
      return Boolean(s && s.expiresAt > Date.now());
    },

    // Jeton agent : généré dans Réglages, affiché une seule fois, stocké haché
    generateAgentToken() {
      const token = `cs_agent_${crypto.randomBytes(24).toString('base64url')}`;
      registerSecret(token);
      store.tx((db) => { db.agentToken = { hash: sha256(token), createdAt: new Date().toISOString() }; });
      return token;
    },

    revokeAgentToken() {
      store.tx((db) => { db.agentToken = null; });
    },

    agentTokenState() {
      return {
        configured: Boolean(store.data.agentToken) || Boolean(config.agentTokenEnv),
        createdAt: store.data.agentToken?.createdAt ?? null,
        fromEnv: Boolean(config.agentTokenEnv)
      };
    },

    checkAgentToken(token) {
      if (!token) return false;
      if (config.agentTokenEnv && safeEqualHex(sha256(token), sha256(config.agentTokenEnv))) return true;
      const stored = store.data.agentToken;
      return Boolean(stored) && safeEqualHex(sha256(token), stored.hash);
    }
  };
}
