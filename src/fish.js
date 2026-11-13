// Adaptateur HTTP Fish Audio. Hôte fixé dans le code, redirections refusées,
// lecture bornée du flux. La clé ne quitte jamais ce module.
import { FISH_TTS_URL } from '../shared/payload.js';
import { redactString } from './redact.js';

const FISH_BASE = 'https://api.fish.audio';
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Échantillon accepté uniquement depuis le stockage de Fish Audio (autorisé par la CSP)
function sample(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && u.host === SAMPLE_HOST ? u.href : null; } catch { return null; }
}
export const SAMPLE_HOST = 'platform.r2.fish.audio';

export class ProviderError extends Error {
  // code : auth | payment | rate_limited | provider_error | uncertain | invalid_audio | redirect | not_found | bad_request
  constructor(code, message, { httpStatus = null, retryAfterMs = null } = {}) {
    super(redactString(message));
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

// Lecture d'un flux avec limite de volume et mesure du premier octet
async function readBody(response, limit, onFirstByte) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first && value?.length) { first = false; onFirstByte?.(); }
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new ProviderError('invalid_audio', 'Réponse trop volumineuse.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Message d'erreur fournisseur : uniquement status/message, tronqué et expurgé
function providerMessage(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    return redactString(String(j.message ?? j.detail ?? '').slice(0, 300));
  } catch {
    return '';
  }
}

function classify(status, message, retryAfter) {
  const detail = message ? ` (${message})` : '';
  // Limite liée au crédit (ex. création de voix via l'API) : pas un problème de clé
  if (/credit|top up|limit reached|quota/i.test(message)) {
    return new ProviderError('payment', `Limite Fish Audio atteinte : crédit API requis pour cette opération${detail}.`, { httpStatus: status });
  }
  if (status === 401 || status === 403) return new ProviderError('auth', `Accès refusé par Fish Audio${detail}.`, { httpStatus: status });
  if (status === 402) return new ProviderError('payment', `Solde ou offre insuffisant${detail}.`, { httpStatus: status });
  if (status === 404) return new ProviderError('not_found', `Ressource introuvable chez Fish Audio${detail}.`, { httpStatus: status });
  if (status === 429) {
    const s = Number(retryAfter);
    return new ProviderError('rate_limited', `Trop de requêtes${detail}.`, { httpStatus: status, retryAfterMs: Number.isFinite(s) ? s * 1000 : null });
  }
  if (status >= 500) return new ProviderError('uncertain', `Erreur serveur Fish Audio ${status}${detail}.`, { httpStatus: status });
  return new ProviderError('bad_request', `Requête refusée par Fish Audio (${status})${detail}.`, { httpStatus: status });
}

export function createFishClient({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  // Clé modifiable à chaud depuis Réglages (setApiKey)
  let key = apiKey || '';
  const authHeader = () => {
    if (!key) throw new ProviderError('auth', 'Clé Fish Audio absente : à renseigner dans Réglages.');
    return `Bearer ${key}`;
  };

  async function send(url, init, { phase = 'before_send' } = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Après envoi, une rupture réseau ou un délai dépassé laisse le résultat incertain
      throw new ProviderError(phase === 'generative' ? 'uncertain' : 'provider_error',
        e?.name === 'TimeoutError' ? 'Délai dépassé.' : 'Erreur réseau vers Fish Audio.');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ProviderError('redirect', 'Redirection inattendue refusée.', { httpStatus: response.status });
    }
    return response;
  }

  return {
    get configured() { return Boolean(key); },
    setApiKey(value) { key = value || ''; },

    // POST /v1/tts : renvoie l'audio brut et les mesures côté serveur
    async tts({ providerModel, body, onSent, onFirstByte }) {
      const headers = { Authorization: authHeader(), 'Content-Type': 'application/json', model: providerModel };
      const t0 = Date.now();
      onSent?.();
      const res = await send(FISH_TTS_URL, { method: 'POST', headers, body: JSON.stringify(body) }, { phase: 'generative' });
      let firstByteAt = null;
      if (res.status !== 200) {
        const errBuf = await readBody(res, MAX_ERROR_BYTES).catch(() => Buffer.alloc(0));
        throw classify(res.status, providerMessage(errBuf), res.headers.get('retry-after'));
      }
      const contentType = res.headers.get('content-type') || '';
      let audio;
      try {
        audio = await readBody(res, MAX_AUDIO_BYTES, () => { firstByteAt = Date.now(); onFirstByte?.(); });
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError('uncertain', 'Flux audio interrompu.');
      }
      if (/json/i.test(contentType)) {
        throw new ProviderError('invalid_audio', `Réponse JSON reçue à la place d'un audio${providerMessage(audio) ? ` (${providerMessage(audio)})` : ''}.`, { httpStatus: 200 });
      }
      return {
        httpStatus: res.status,
        contentType: contentType.slice(0, 60),
        audio,
        ttfbMs: firstByteAt ? firstByteAt - t0 : null,
        totalMs: Date.now() - t0
      };
    },

    // GET /model/{id} : vérification d'une voix, champs autorisés uniquement
    async getVoice(id) {
      if (!VOICE_ID_RE.test(String(id))) throw new ProviderError('bad_request', 'Identifiant de voix invalide.');
      const res = await send(`${FISH_BASE}/model/${encodeURIComponent(id)}`, { method: 'GET', headers: { Authorization: authHeader() } });
      const buf = await readBody(res, 2 * 1024 * 1024);
      if (res.status !== 200) throw classify(res.status, providerMessage(buf));
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('bad_request', 'Réponse illisible.'); }
      return {
        id: String(j._id ?? ''),
        type: j.type ?? null,
        title: String(j.title ?? '').slice(0, 120),
        state: j.state ?? null,
        visibility: j.visibility ?? null,
        sampleUrl: sample(j.samples?.[0]?.audio),
        takenDown: Boolean(j.dmca_taken_down) || Boolean(j.takedown_category)
      };
    },

    // GET /model?self=true : voix du compte (jamais le catalogue public)
    async listOwnVoices() {
      const res = await send(`${FISH_BASE}/model?self=true&page_size=50&page_number=1`, { method: 'GET', headers: { Authorization: authHeader() } });
      const buf = await readBody(res, 4 * 1024 * 1024);
      if (res.status !== 200) throw classify(res.status, providerMessage(buf));
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('bad_request', 'Réponse illisible.'); }
      const items = Array.isArray(j.items) ? j.items : [];
      return {
        total: Number.isFinite(j.total) ? j.total : items.length,
        items: items.map((v) => ({
          id: String(v._id ?? ''),
          type: v.type ?? null,
          title: String(v.title ?? '').slice(0, 120),
          state: v.state ?? null,
          visibility: v.visibility ?? null,
          takenDown: Boolean(v.dmca_taken_down) || Boolean(v.takedown_category)
        })).filter((v) => VOICE_ID_RE.test(v.id))
      };
    },

    // GET /model : catalogue public, voix françaises triées par popularité, champs autorisés uniquement
    async searchVoices({ tags = [], licensedOnly = true, page = 1 } = {}) {
      const params = new URLSearchParams({ page_size: '12', page_number: String(page), sort_by: 'task_count', language: 'fr' });
      if (licensedOnly) params.set('licensed', 'true');
      // Plusieurs étiquettes : la voix doit les avoir toutes
      for (const t of tags) params.append('tag', t);
      const res = await send(`${FISH_BASE}/model?${params}`, { method: 'GET', headers: { Authorization: authHeader() } });
      const buf = await readBody(res, 4 * 1024 * 1024);
      if (res.status !== 200) throw classify(res.status, providerMessage(buf));
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('bad_request', 'Réponse illisible.'); }
      const items = Array.isArray(j.items) ? j.items : [];
      return {
        total: Number.isFinite(j.total) ? j.total : items.length,
        hasMore: j.has_more === true || (Number.isFinite(j.total) && page * 12 < j.total),
        items: items.map((v) => ({
          id: String(v._id ?? ''),
          type: v.type ?? null,
          title: String(v.title ?? '').slice(0, 120),
          author: String(v.author?.nickname ?? '').slice(0, 80),
          state: v.state ?? null,
          visibility: v.visibility ?? null,
          licensed: v.licensed === true,
          uses: Number.isFinite(v.task_count) ? v.task_count : null,
          sampleUrl: sample(v.samples?.[0]?.audio),
          tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string').slice(0, 30) : [],
          takenDown: Boolean(v.dmca_taken_down) || Boolean(v.takedown_category)
        })).filter((v) => VOICE_ID_RE.test(v.id))
      };
    },

    // POST /model en multipart : création d'une voix privée
    async createVoice({ title, file, fileName, mimeType, transcript, enhanceAudio }) {
      const form = new FormData();
      form.append('type', 'tts');
      form.append('title', title);
      form.append('train_mode', 'fast');
      form.append('visibility', 'private');
      form.append('generate_sample', 'false');
      form.append('enhance_audio_quality', enhanceAudio ? 'true' : 'false');
      form.append('voices', new Blob([file], { type: mimeType }), fileName);
      if (transcript) form.append('texts', transcript);
      const res = await send(`${FISH_BASE}/model`, { method: 'POST', headers: { Authorization: authHeader() }, body: form });
      const buf = await readBody(res, 2 * 1024 * 1024);
      if (res.status !== 200 && res.status !== 201) throw classify(res.status, providerMessage(buf));
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('bad_request', 'Réponse illisible.'); }
      if (!j._id) throw new ProviderError('bad_request', 'Aucun identifiant de voix renvoyé.');
      return { id: String(j._id) };
    }
  };
}
