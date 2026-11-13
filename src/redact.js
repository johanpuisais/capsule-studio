// Expurgation centrale : toute chaîne sortante (erreur, journal, réponse) passe ici.

const secrets = new Set();

// Enregistre une valeur secrète à masquer partout (clé Fish, jeton agent…)
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

export function redactString(input) {
  let s = String(input ?? '');
  for (const secret of secrets) s = s.split(secret).join('[MASQUÉ]');
  // Tout en-tête Bearer résiduel
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer [MASQUÉ]');
  return s;
}

// Expurgation récursive d'un objet JSON
export function redactDeep(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // La constante d'affichage du masque (aucun secret) reste lisible
      const sensitive = /authorization|api[_-]?key|token|password|secret/i.test(k) && typeof v === 'string' && !v.startsWith('Bearer [CLÉ MASQUÉE');
      out[k] = sensitive ? '[MASQUÉ]' : redactDeep(v);
    }
    return out;
  }
  return value;
}

// Journal à champs autorisés uniquement
const LOG_FIELDS = ['event', 'jobId', 'planId', 'state', 'httpStatus', 'model', 'bytes', 'ms', 'code', 'route', 'status'];
export function log(entry) {
  const safe = {};
  for (const k of LOG_FIELDS) if (entry[k] !== undefined) safe[k] = entry[k];
  console.log(redactString(`[capsule] ${new Date().toISOString()} ${JSON.stringify(safe)}`));
}
