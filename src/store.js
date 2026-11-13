// Stockage local en un fichier JSON, écriture atomique (fichier temporaire + renommage).
// Les transactions sont synchrones : Node étant mono-thread, rien ne s'intercale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLLECTIONS = ['projects', 'segments', 'revisions', 'voices', 'proposals', 'plans', 'jobs', 'takes', 'sessions'];

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let db;
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    db = { version: 1, owner: null, agentToken: null, paidReservedUsd: 0 };
  }
  for (const c of COLLECTIONS) db[c] ??= {};

  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    file,
    // Lecture seule (copie défensive non nécessaire : les appelants ne mutent pas)
    get data() { return db; },
    tx(fn) {
      const result = fn(db);
      persist();
      return result;
    },
    list(collection, filter = () => true) {
      return Object.values(db[collection]).filter(filter);
    },
    get(collection, id) {
      return typeof id === 'string' && Object.prototype.hasOwnProperty.call(db[collection], id) ? db[collection][id] : null;
    }
  };
}
