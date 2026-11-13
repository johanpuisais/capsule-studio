// Module partagé navigateur + serveur : aucun secret ici.
// Le même code construit l'aperçu, le comptage UTF-8 et la requête réellement envoyée.

// Raccourcis d'intention : ils insèrent une indication textuelle visible,
// ce ne sont pas des paramètres d'émotion garantis par l'API.
export const INTENTS = [
  { id: 'neutral', label: 'Neutre', tag: '' },
  { id: 'calm', label: 'Calme', tag: '[calm]' },
  { id: 'worried', label: 'Inquiet', tag: '[worried]' },
  { id: 'excited', label: 'Enthousiaste', tag: '[excited]' },
  { id: 'whisper', label: 'Chuchoté', tag: '[whispering]' }
];

// Étiquettes du catalogue Fish Audio proposées en filtres (relevées le 2026-10-23 sur les voix françaises)
export const VOICE_TAG_GROUPS = [
  { label: 'Voix', tags: [['male', 'Homme'], ['female', 'Femme']] },
  { label: 'Âge', tags: [['young', 'Jeune'], ['middle-aged', 'Adulte'], ['old', 'Âgée']] },
  { label: 'Style', tags: [['narration', 'Narration'], ['conversational', 'Conversation'], ['calm', 'Calme'], ['energetic', 'Énergique'], ['warm', 'Chaleureuse'], ['deep', 'Grave'], ['soft', 'Douce'], ['professional', 'Professionnelle'], ['storytelling', 'Conteur']] }
];
export const VOICE_TAGS = Object.fromEntries(VOICE_TAG_GROUPS.flatMap((g) => g.tags));

// Montage : silence par défaut, réglages des pistes A/B, décalage propre à chaque segment (en secondes)
export const DEFAULT_TRACK_MIX = Object.freeze({ volume: 0, low: 0, mid: 0, high: 0, comp: false, room: 0, mute: false, solo: false });
// Musique de fond : volume, baisse sous les voix (dB), fondus, durée après la dernière réplique, position
export const DEFAULT_MUSIC_MIX = Object.freeze({ volume: -18, duck: 10, fadeIn: 2, fadeOut: 3, tail: 3, start: 0, loop: true, mute: false, solo: false });
const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const ms = (v) => Math.round(v * 1000) / 1000;
const SEG_ID = /^seg_[A-Za-z0-9_-]{1,60}$/;

// Validation stricte : renvoie un montage propre, ou null si une valeur est hors bornes
export function cleanMontage(o) {
  if (!o || typeof o !== 'object') return null;
  const gap = o.gap ?? 0.3;
  if (!inRange(gap, 0, 2)) return null;
  const mix = {};
  for (const k of ['A', 'B']) {
    const m = { ...DEFAULT_TRACK_MIX, ...(o.mix?.[k] ?? {}) };
    if (!inRange(m.volume, -24, 6) || !inRange(m.low, -12, 12) || !inRange(m.mid, -12, 12) || !inRange(m.high, -12, 12) || !inRange(m.room, 0, 1)) return null;
    if (typeof m.comp !== 'boolean' || typeof m.mute !== 'boolean' || typeof m.solo !== 'boolean') return null;
    mix[k] = { volume: m.volume, low: m.low, mid: m.mid, high: m.high, comp: m.comp, room: m.room, mute: m.mute, solo: m.solo };
  }
  const nudges = {};
  const entries = Object.entries(o.nudges ?? {});
  if (entries.length > 1000) return null;
  for (const [id, v] of entries) {
    if (!SEG_ID.test(id) || !inRange(v, -60, 60)) return null;
    // Décalages nuls inutiles : non conservés
    if (v !== 0) nudges[id] = ms(v);
  }
  // Pause maximale gardée par « Raccourcir les blancs »
  const maxPause = o.maxPause ?? 0.5;
  if (!inRange(maxPause, 0.1, 2)) return null;
  // Coupes par segment, en secondes de la prise : début, fin, blancs retirés à l'intérieur
  const edits = {};
  const editEntries = Object.entries(o.edits ?? {});
  if (editEntries.length > 1000) return null;
  for (const [id, e] of editEntries) {
    if (!SEG_ID.test(id) || !e || typeof e !== 'object') return null;
    const cutIn = e.in ?? 0;
    const cutOut = e.out ?? 0;
    const cuts = e.cuts ?? [];
    if (!inRange(cutIn, 0, 600) || !inRange(cutOut, 0, 600) || !Array.isArray(cuts) || cuts.length > 300) return null;
    for (const c of cuts) if (!Array.isArray(c) || c.length !== 2 || !inRange(c[0], 0, 3600) || !inRange(c[1], 0, 3600) || c[0] >= c[1]) return null;
    // Segment sans coupe : non conservé
    if (cutIn || cutOut || cuts.length) edits[id] = { in: ms(cutIn), out: ms(cutOut), cuts: cuts.map(([a, b]) => [ms(a), ms(b)]) };
  }
  const music = { ...DEFAULT_MUSIC_MIX, ...(o.music ?? {}) };
  if (!inRange(music.volume, -40, 6) || !inRange(music.duck, 0, 30) || !inRange(music.fadeIn, 0, 15) || !inRange(music.fadeOut, 0, 15) || !inRange(music.tail, 0, 30) || !inRange(music.start, 0, 3600)) return null;
  if (typeof music.loop !== 'boolean' || typeof music.mute !== 'boolean' || typeof music.solo !== 'boolean') return null;
  return {
    gap, mix, nudges, maxPause, edits,
    music: { volume: music.volume, duck: music.duck, fadeIn: music.fadeIn, fadeOut: music.fadeOut, tail: music.tail, start: ms(music.start), loop: music.loop, mute: music.mute, solo: music.solo }
  };
}

// Musique de fond : formats reconnus par leur signature (pas par l'extension)
export const MUSIC_FORMATS = Object.freeze({ wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4' });
export function sniffMusic(b) {
  if (!b || b.length < 12) return null;
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(4, 8) === 'ftyp') return 'm4a';
  return null;
}

// Paramètre fixe : meilleure qualité de génération ("normal")
export const AUDIO_PARAMS = Object.freeze({ latency: 'normal' });

// Formats proposés : WAV sans perte (montage) ou MP3 au débit maximal de l'API (192 kbit/s)
export const FORMATS = Object.freeze({
  wav: { label: 'WAV sans perte', ext: 'wav', mime: 'audio/wav' },
  mp3: { label: 'MP3 192 kbit/s', ext: 'mp3', mime: 'audio/mpeg' }
});
// Fish Audio ne produit pas de WAV au-delà de 44,1 kHz (48 kHz refusé : 400)
export const SAMPLE_RATES = [44100];

export const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
export const AUTH_MASK = 'Bearer [CLÉ MASQUÉE, CONSERVÉE CÔTÉ SERVEUR]';

// Indication de ton : toujours une seule balise entre crochets (ex. "calme" → "[calme]").
// Évite qu'un texte tapé hors des crochets soit lu à voix haute par la voix.
export function normalizeInstruction(value) {
  const inner = String(value ?? '').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return inner ? `[${inner}]` : '';
}

// Texte final envoyé : indication + texte parlé, sans réécriture silencieuse
export function buildFinalText(spokenText, instruction) {
  const text = String(spokenText ?? '').trim();
  const tag = String(instruction ?? '').trim();
  return tag ? `${tag} ${text}` : text;
}

// Comptage en octets UTF-8 (identique à Buffer.byteLength(text, 'utf8'))
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

// Réglages audio exposés (schéma Fish Audio ProsodyControl) : valeurs par défaut du fournisseur
export const DEFAULT_AUDIO_OPTIONS = Object.freeze({ normalizeLoudness: true, volumeDb: -1, format: 'wav', sampleRate: 44100 });
export const VOLUME_STEPS = [0, -1, -2, -3, -6, -9, -12];

// Validation stricte : renvoie des options propres ou null si invalides
export function cleanAudioOptions(o) {
  if (o === undefined || o === null) return { ...DEFAULT_AUDIO_OPTIONS };
  if (typeof o !== 'object') return null;
  const d = DEFAULT_AUDIO_OPTIONS;
  const normalizeLoudness = o.normalizeLoudness ?? d.normalizeLoudness;
  const volumeDb = o.volumeDb ?? d.volumeDb;
  const format = o.format ?? d.format;
  const sampleRate = o.sampleRate ?? d.sampleRate;
  if (typeof normalizeLoudness !== 'boolean' || !Number.isInteger(volumeDb) || volumeDb < -20 || volumeDb > 6) return null;
  if (!Object.prototype.hasOwnProperty.call(FORMATS, format) || !SAMPLE_RATES.includes(sampleRate)) return null;
  return { normalizeLoudness, volumeDb, format, sampleRate };
}

// Libellé court des réglages, vide s'ils sont ceux par défaut
export function audioOptionsLabel(o) {
  const parts = [];
  if (o?.format) parts.push(`${o.format.toUpperCase()} ${(o.sampleRate / 1000).toString().replace('.', ',')} kHz`);
  if (o && o.normalizeLoudness === false) parts.push('sans normalisation');
  if (o && o.volumeDb) parts.push(`${o.volumeDb > 0 ? '+' : ''}${o.volumeDb} dB`);
  return parts.join(' · ');
}

// Corps JSON de POST /v1/tts : liste fermée de champs, prosodie toujours explicite
export function buildTtsBody(finalText, referenceId, audioOptions = DEFAULT_AUDIO_OPTIONS) {
  return {
    text: finalText,
    reference_id: referenceId,
    format: audioOptions.format,
    ...(audioOptions.format === 'mp3' ? { mp3_bitrate: 192 } : {}),
    sample_rate: audioOptions.sampleRate,
    ...AUDIO_PARAMS,
    prosody: { normalize_loudness: audioOptions.normalizeLoudness, volume: audioOptions.volumeDb }
  };
}

// Vue expurgée de la requête : en-têtes autorisés uniquement
export function redactedRequest(providerModel, body) {
  return {
    method: 'POST',
    url: FISH_TTS_URL,
    headers: {
      Authorization: AUTH_MASK,
      'Content-Type': 'application/json',
      model: providerModel
    },
    body
  };
}

// Estimation USD = octets × prix / 1 000 000 ; prix inconnu → null (jamais 0)
export function estimateUsd(bytes, pricePerMillionBytes) {
  if (typeof pricePerMillionBytes !== 'number' || !Number.isFinite(pricePerMillionBytes)) return null;
  return Math.round(bytes * pricePerMillionBytes) / 1e6;
}
