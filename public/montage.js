// Capsule Studio : page Montage.
// Étape 1 : une piste par intervenant, prises retenues placées à la suite, lecture Web Audio.
// Étape 2 : réglages par piste (volume, égaliseur 3 bandes, compresseur, muet/solo) et export WAV.
// Étape 3 : segments déplaçables (silences et chevauchements), réverbération de pièce, réglages enregistrés sur le serveur.
// Étape 4 : coupes dans les segments (poignées début/fin, blancs raccourcis automatiquement) et piste musique avec baisse sous les voix.
// Tout est calculé dans le navigateur : aucun appel à Fish Audio.

import { DEFAULT_TRACK_MIX, DEFAULT_MUSIC_MIX, cleanMontage } from '/shared/payload.js';

const ZOOMS = [20, 40, 60, 90, 140];
const GAPS = [0, 0.15, 0.3, 0.5, 1];
// Pause gardée quand on raccourcit les blancs d'un segment
const PAUSES = [0.2, 0.3, 0.5, 0.8, 1];
const RULER_H = 28;
const LANE_H = 196;
const MUSIC_EMPTY_H = 76;
// Pas de déplacement à la souris (Maj : réglage fin)
const SNAP = 0.05;
const SNAP_FINE = 0.01;
const CHARS_PER_SEC = 15;
// Fréquence de travail = celle des prises Fish Audio : décodage et export sans rééchantillonnage
const SAMPLE_RATE = 44100;
// Micro-fondu à chaque raccord de coupe (évite les clics)
const PIECE_FADE = 0.004;
// Durée minimale d'un segment rogné
const MIN_CLIP = 0.1;
// Baisse de la musique : descente avant la voix, remontée après
const DUCK_ATTACK = 0.25;
const DUCK_RELEASE = 0.6;
// Largeur maximale d'un canvas de forme d'onde (limite des navigateurs)
const MAX_CANVAS = 16000;

// Égaliseur : plateau grave, cloche médium, plateau aigu (comme une tranche de console)
const EQ_BANDS = [
  { key: 'low', label: 'Grave', type: 'lowshelf', freq: 150 },
  { key: 'mid', label: 'Médium', type: 'peaking', freq: 1500, q: 0.9 },
  { key: 'high', label: 'Aigu', type: 'highshelf', freq: 6000 }
];

// Durée lisible : 1:05,3
const fmtClock = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0').replace('.', ',')}`;
};
const fmtDb = (db) => `${db > 0 ? '+' : ''}${String(db.toFixed(1)).replace('.', ',')} dB`;
const fmtSec = (s, d = 1) => `${s.toFixed(d).replace('.', ',')} s`;
const dbToGain = (db) => 10 ** (db / 20);
const ms = (v) => Math.round(v * 1000) / 1000;

// Petite pièce : bruit à décroissance exponentielle (0,6 s), généré avec une graine fixe
function createImpulse(ctx) {
  const len = Math.round(ctx.sampleRate * 0.6);
  const ir = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = ir.getChannelData(0);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < len; i++) d[i] = rnd() * Math.exp(-i / (ctx.sampleRate * 0.12));
  return ir;
}

// Chaîne d'une piste : égaliseur → compresseur (facultatif) → volume, puis envoi vers la pièce.
// Utilisée à l'identique pour l'écoute et pour l'export (rendu fidèle).
function createChain(ctx, destination, impulse) {
  const eq = EQ_BANDS.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    if (b.q) f.Q.value = b.q;
    return f;
  });
  eq.reduce((a, b) => { a.connect(b); return b; });
  // Compresseur doux pour la voix : niveaux plus réguliers sans pompage audible
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 8;
  comp.ratio.value = 3;
  comp.attack.value = 0.005;
  comp.release.value = 0.18;
  // Compensation du gain perdu par la compression
  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(3);
  comp.connect(makeup);
  const out = ctx.createGain();
  out.connect(destination);
  // Envoi après le volume vers la réverbération (son « dans la pièce »)
  const send = ctx.createGain();
  send.gain.value = 0;
  const conv = ctx.createConvolver();
  conv.buffer = impulse;
  out.connect(send);
  send.connect(conv);
  conv.connect(destination);
  let compOn = null;
  return {
    input: eq[0],
    apply(mix, audible, smooth = true) {
      const set = (param, v) => (smooth && ctx.state === 'running' ? param.setTargetAtTime(v, ctx.currentTime, 0.02) : (param.value = v));
      EQ_BANDS.forEach((b, i) => set(eq[i].gain, mix[b.key]));
      set(out.gain, audible ? dbToGain(mix.volume) : 0);
      // Pièce : 0 à 100 % correspond à un envoi de 0 à -6 dB environ
      set(send.gain, mix.room * 0.5);
      // Compresseur branché ou contourné
      if (compOn !== mix.comp) {
        const last = eq[eq.length - 1];
        last.disconnect();
        makeup.disconnect();
        if (mix.comp) { last.connect(comp); makeup.connect(out); } else last.connect(out);
        compOn = mix.comp;
      }
    }
  };
}

// Chaîne de la musique : enveloppe (fondus + baisse sous les voix) → volume
function createMusicChain(ctx, destination) {
  const env = ctx.createGain();
  const vol = ctx.createGain();
  env.connect(vol);
  vol.connect(destination);
  return {
    input: env,
    env,
    apply(mix, audible, smooth = true) {
      const v = audible ? dbToGain(mix.volume) : 0;
      if (smooth && ctx.state === 'running') vol.gain.setTargetAtTime(v, ctx.currentTime, 0.02); else vol.gain.value = v;
    }
  };
}

// Limiteur général : évite l'écrêtage quand on monte les volumes
function createLimiter(ctx) {
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.002;
  lim.release.value = 0.1;
  lim.connect(ctx.destination);
  return lim;
}

// WAV PCM 16 bits, mono ou stéréo (canaux entrelacés)
function encodeWav(channels, rate) {
  const n = channels.length;
  const frames = channels[0].length;
  const size = frames * n * 2;
  const buf = new ArrayBuffer(44 + size);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + size, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * n * 2, true); v.setUint16(32, n * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, size, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// CRC-32 (ZIP) : table calculée une fois
let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Archive ZIP « stockée » (sans compression : le WAV ne se compresse presque pas), noms ASCII
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
    central.push(cen.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// Nom de fichier sans accents ni espaces
const slugName = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Morceaux joués d'une prise, en secondes de la prise : [début, fin] privé des blancs retirés
function piecesOf(dur, edit) {
  const end = Math.max(0, dur - (edit?.out ?? 0));
  let pos = Math.min(edit?.in ?? 0, end);
  const out = [];
  const cuts = [...(edit?.cuts ?? [])].sort((a, b) => a[0] - b[0]);
  for (const [a, b] of cuts) {
    if (b <= pos) continue;
    if (a >= end) break;
    if (a > pos) out.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (end > pos) out.push([pos, end]);
  return out;
}
const piecesDur = (pieces) => pieces.reduce((s, [a, b]) => s + b - a, 0);

// Blancs d'une prise : fenêtres de 10 ms nettement sous le niveau de la voix (-40 dB sous la crête)
function findSilences(buf) {
  const data = buf.getChannelData(0);
  const win = Math.max(1, Math.round(buf.sampleRate * 0.01));
  const n = Math.floor(data.length / win);
  const rms = new Float32Array(n);
  let peak = 0;
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += data[i] * data[i];
    rms[w] = Math.sqrt(sum / win);
    if (rms[w] > peak) peak = rms[w];
  }
  if (!peak) return [];
  const thr = peak * dbToGain(-40);
  const runs = [];
  let from = -1;
  for (let w = 0; w <= n; w++) {
    const silent = w < n && rms[w] < thr;
    if (silent && from < 0) from = w;
    if (!silent && from >= 0) { runs.push([from * 0.01, Math.min(buf.duration, w * 0.01)]); from = -1; }
  }
  return runs;
}

// Coupes automatiques : blancs de tête et de queue réduits à 80 ms, blancs intérieurs ramenés à « pause gardée »
function autoEdit(buf, maxPause) {
  const dur = buf.duration;
  const edge = 0.08;
  let cutIn = 0;
  let cutOut = 0;
  const cuts = [];
  for (const [a, b] of findSilences(buf)) {
    if (a <= 0.011) { cutIn = Math.max(0, b - edge); continue; }
    if (b >= dur - 0.011) { cutOut = Math.max(0, dur - a - edge); continue; }
    // Coupe d'au moins 10 ms : un blanc égal à la pause gardée (arrondi flottant) donnerait une coupe vide, refusée par le serveur
    const cut = [ms(a + maxPause / 2), ms(b - maxPause / 2)];
    if (cut[1] - cut[0] >= 0.01) cuts.push(cut);
  }
  // Prise entièrement silencieuse : rien n'est coupé
  if (cutIn + cutOut >= dur - MIN_CLIP) return null;
  return { in: ms(cutIn), out: ms(cutOut), cuts };
}

// Valeur d'une enveloppe [[temps, valeur], …] (interpolation linéaire)
function envAt(pts, t) {
  if (!pts.length) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    if (t <= t1) {
      const [t0, v0] = pts[i - 1];
      return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    }
  }
  return pts[pts.length - 1][1];
}

// Lecture d'un morceau de prise avec micro-fondus d'entrée et de sortie
function schedulePiece(ctx, buf, dest, when, from, len) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  const f = Math.min(PIECE_FADE, len / 2);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(1, when + f);
  g.gain.setValueAtTime(1, when + len - f);
  g.gain.linearRampToValueAtTime(0, when + len);
  src.connect(g);
  g.connect(dest);
  src.start(when, from, len);
  return src;
}

export function createMontage(app) {
  const { fill, toast, store } = app;
  // Styles posés par le DOM (la CSP interdit l'attribut style en ligne)
  const h = (tag, attrs = {}, ...kids) => {
    const { style, ...rest } = attrs || {};
    const el = app.h(tag, rest, ...kids);
    if (style) el.style.cssText = style;
    return el;
  };
  // État : contexte audio, tampons décodés, chaînes des pistes, sources en cours, réglages
  const st = {
    ctx: null, limiter: null, impulse: null, buffers: new Map(), sources: [], chains: {}, mix: {}, nudges: {}, edits: {}, maxPause: 0.5,
    music: { ...DEFAULT_MUSIC_MIX }, musicBuf: null, musicKey: null, musicRegion: null, musicChain: null,
    playing: false, offset: 0, startedAt: 0, raf: 0, clips: [], clipEls: new Map(), selected: null, total: 0, voiceEnd: 0,
    pps: 60, gap: 0.3, els: null, project: null, saveTimer: 0
  };

  const ctxAudio = () => {
    if (!st.ctx) {
      st.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      st.limiter = createLimiter(st.ctx);
      st.impulse = createImpulse(st.ctx);
    }
    return st.ctx;
  };
  // Jamais négative (la lecture démarre 50 ms après le clic)
  const position = () => (st.playing ? Math.max(0, st.ctx.currentTime - st.startedAt) : st.offset);
  const keys = () => (st.project?.mode === 'dialogue' ? ['A', 'B'] : ['A']);
  const hasMusic = () => Boolean(st.project?.music);
  // Pistes soumises au muet/solo : voix, plus la musique quand il y en a une
  const tracks = () => (hasMusic() ? [...keys(), 'M'] : keys());
  const mixOf = (k) => (k === 'M' ? st.music : st.mix[k]);

  // ---------- Réglages du montage (enregistrés sur le serveur, par projet) ----------
  function loadMix() {
    let m = st.project.montage && cleanMontage(st.project.montage);
    let migrated = false;
    if (!m) {
      // Première ouverture depuis l'étape 3 : reprise des réglages gardés dans ce navigateur
      let mix = {};
      try { mix = JSON.parse(store.get(`cs.montage.mix.${st.project.id}`, '{}')) || {}; } catch { mix = {}; }
      const gap = Number(store.get(`cs.montage.gap.${st.project.id}`, '0.3'));
      m = cleanMontage({ gap, mix }) ?? cleanMontage({});
      migrated = Boolean(Object.keys(mix).length) || store.get(`cs.montage.gap.${st.project.id}`) !== null;
    }
    st.gap = m.gap;
    st.mix = { A: { ...m.mix.A }, B: { ...m.mix.B } };
    st.nudges = { ...m.nudges };
    st.edits = structuredClone(m.edits);
    st.maxPause = m.maxPause;
    st.music = { ...m.music };
    if (migrated) saveMix(true);
  }
  // Enregistrement groupé (un appel au plus toutes les 0,6 s pendant les réglages)
  function saveMix(now = false) {
    clearTimeout(st.saveTimer);
    const project = st.project;
    const send = async () => {
      try {
        const res = await app.api('POST', `/api/v1/projects/${project.id}/montage`, { gap: st.gap, mix: st.mix, nudges: st.nudges, maxPause: st.maxPause, edits: st.edits, music: st.music });
        project.montage = res.montage;
      } catch (e) { toast(`Réglages du montage non enregistrés : ${e.message}`, 'error'); }
    };
    if (now) send(); else st.saveTimer = setTimeout(send, 600);
  }
  // Piste audible : pas muette, et seule les pistes « solo » quand il y en a
  const audible = (k) => {
    const anySolo = tracks().some((x) => mixOf(x).solo);
    return !mixOf(k).mute && (!anySolo || mixOf(k).solo);
  };
  function chain(k) {
    if (!st.chains[k]) st.chains[k] = createChain(ctxAudio(), st.limiter, st.impulse);
    return st.chains[k];
  }
  function musicChain() {
    if (!st.musicChain) st.musicChain = createMusicChain(ctxAudio(), st.limiter);
    return st.musicChain;
  }
  function applyMix(smooth = true) {
    for (const k of keys()) chain(k).apply(st.mix[k], audible(k), smooth);
    if (hasMusic()) musicChain().apply(st.music, audible('M'), smooth);
  }

  // Placement : chaque segment démarre après la fin du précédent + silence + son décalage propre.
  // Un décalage négatif crée un chevauchement ; les segments suivants suivent le mouvement.
  function layout() {
    const dialogue = st.project.mode === 'dialogue';
    let prev = null;
    st.clips = st.project.segments.map((seg, i) => {
      const take = seg.takes.find((x) => x.id === seg.chosenTakeId) ?? null;
      const buf = take && st.buffers.get(take.id);
      // Morceaux réellement joués (coupes appliquées) ; sans tampon, prise entière
      const pieces = buf ? piecesOf(buf.duration, st.edits[seg.id]) : null;
      // Sans prise : durée estimée d'après le texte, bloc en pointillés non joué
      const dur = pieces ? piecesDur(pieces) : take?.durationSec ?? Math.max(1, (seg.revision?.spokenText?.length ?? 0) / CHARS_PER_SEC);
      const nudge = st.nudges[seg.id] ?? 0;
      // Jamais avant le début du segment précédent (l'ordre du script est conservé)
      const start = prev ? Math.max(prev.start, prev.start + prev.dur + st.gap + nudge) : Math.max(0, nudge);
      const clip = { seg, take, buf, pieces, index: i, speaker: dialogue ? seg.speaker : 'A', start, dur };
      prev = clip;
      return clip;
    });
    st.voiceEnd = st.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
    // Musique : de sa position jusqu'à la fin des voix + « après la fin », ou jusqu'à la fin du morceau sans boucle
    st.musicRegion = null;
    if (hasMusic() && st.musicBuf) {
      const start = st.music.start;
      const wanted = Math.max(start + 1, st.voiceEnd + st.music.tail);
      const end = st.music.loop ? wanted : Math.min(wanted, start + st.musicBuf.duration);
      st.musicRegion = { start, end };
    }
    st.total = Math.max(st.voiceEnd, st.musicRegion?.end ?? 0);
  }
  // Silence (positif) ou chevauchement (négatif) avant un segment
  const pauseBefore = (c) => (c.index === 0 ? c.start : c.start - (st.clips[c.index - 1].start + st.clips[c.index - 1].dur));

  // Enveloppe de la musique sur la ligne de temps : fondus d'entrée/sortie × baisse pendant les voix
  function musicEnvelope() {
    const r = st.musicRegion;
    if (!r) return [];
    const m = st.music;
    const len = r.end - r.start;
    let fi = m.fadeIn;
    let fo = m.fadeOut;
    if (fi + fo > len) { const k = len / (fi + fo); fi *= k; fo *= k; }
    const fade = [[r.start, fi ? 0 : 1], [r.start + fi, 1], [r.end - fo, 1], [r.end, fo ? 0 : 1]];
    // Passages parlés (morceaux joués), regroupés quand la musique n'aurait pas le temps de remonter
    const duck = [];
    if (m.duck > 0) {
      const spans = [];
      for (const c of st.clips) {
        if (!c.pieces) continue;
        let t = c.start;
        for (const [a, b] of c.pieces) { spans.push([t, t + b - a]); t += b - a; }
      }
      spans.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] - last[1] < DUCK_ATTACK + DUCK_RELEASE + 0.2) last[1] = Math.max(last[1], s[1]);
        else merged.push([...s]);
      }
      const low = dbToGain(-m.duck);
      for (const [a, b] of merged) duck.push([a - DUCK_ATTACK, 1], [a, low], [b, low], [b + DUCK_RELEASE, 1]);
    }
    const times = [...new Set([...fade, ...duck].map(([t]) => t).filter((t) => t >= r.start && t <= r.end))].sort((a, b) => a - b);
    return times.map((t) => [t, envAt(fade, t) * envAt(duck, t)]);
  }

  // Décodage des prises retenues (une seule fois par prise)
  async function decodeAll(onProgress) {
    const todo = st.clips.filter((c) => c.take && !st.buffers.has(c.take.id));
    let done = 0;
    for (const c of todo) {
      try {
        const res = await fetch(c.take.audioUrl, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        st.buffers.set(c.take.id, await ctxAudio().decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        toast(`Prise du segment ${c.index + 1} illisible : ${e.message}`, 'error');
      }
      onProgress(++done, todo.length);
    }
  }

  // Décodage de la musique du projet (une fois par fichier envoyé)
  async function decodeMusic() {
    const p = st.project;
    const key = p.music ? `${p.id}:${p.music.uploadedAt}` : null;
    if (key === st.musicKey) return;
    st.musicBuf = null;
    st.musicKey = key;
    if (!key) return;
    try {
      const res = await fetch(`/api/v1/projects/${p.id}/music`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await ctxAudio().decodeAudioData(await res.arrayBuffer());
      if (st.musicKey === key) st.musicBuf = buf;
    } catch (e) {
      st.musicKey = null;
      toast(`Musique illisible par le navigateur : ${e.message}`, 'error');
    }
  }

  // Forme d'onde d'un tampon dans un canvas, morceaux mis bout à bout (maximum absolu par colonne).
  // marks : instants (en secondes du bloc) des raccords de coupe ; env : enveloppe à superposer.
  function drawWave(canvas, buf, color, pieces, { marks = [], env = null, envColor = '' } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(MAX_CANVAS, Math.round(canvas.clientWidth * dpr)));
    const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = w;
    canvas.height = hgt;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, hgt);
    if (!buf || !pieces.length) return;
    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const total = piecesDur(pieces);
    const perPx = total / w;
    g.fillStyle = color;
    let pi = 0;
    let acc = 0;
    for (let x = 0; x < w; x++) {
      const t0 = x * perPx;
      const t1 = t0 + perPx;
      while (pi < pieces.length - 1 && acc + pieces[pi][1] - pieces[pi][0] <= t0) { acc += pieces[pi][1] - pieces[pi][0]; pi++; }
      let peak = 0;
      for (let j = pi, aj = acc; j < pieces.length && aj < t1; j++) {
        const [a, b] = pieces[j];
        const len = b - a;
        const from = Math.floor((a + Math.max(0, t0 - aj)) * sr);
        const to = Math.min(data.length, Math.floor((a + Math.min(len, t1 - aj)) * sr));
        for (let i = from; i < to; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        aj += len;
      }
      const bar = Math.max(1, peak * hgt * 0.9);
      g.fillRect(x, (hgt - bar) / 2, 1, bar);
    }
    // Raccords de coupe : traits verticaux discrets
    g.fillStyle = envColor || color;
    for (const t of marks) g.fillRect(Math.round((t / total) * w), 0, Math.max(1, dpr), hgt);
    // Enveloppe de la musique (0 en bas, 1 en haut)
    if (env?.length) {
      g.strokeStyle = envColor;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      env.forEach(([t, v], i) => {
        const x = (t / total) * w;
        const y = hgt - 2 * dpr - v * (hgt - 4 * dpr);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();
    }
  }

  // Morceaux de la musique à afficher : le morceau répété (boucle) sur toute sa durée
  function musicPieces() {
    const r = st.musicRegion;
    const dur = st.musicBuf.duration;
    const out = [];
    for (let left = r.end - r.start; left > 1e-6;) {
      const len = Math.min(dur, left);
      out.push([0, len]);
      left -= len;
    }
    return out;
  }

  // ---------- Lecture ----------
  function stopSources() {
    for (const s of st.sources) { try { s.stop(); } catch { /* déjà arrêtée */ } }
    st.sources = [];
  }

  // Voix : chaque morceau joué à sa place ; t0 = instant du contexte correspondant à la position « from »
  function scheduleVoices(ctx, inputOf, t0, from) {
    const srcs = [];
    for (const c of st.clips) {
      if (!c.pieces) continue;
      let t = c.start;
      for (const [a, b] of c.pieces) {
        const len = b - a;
        const skip = Math.max(0, from - t);
        if (skip < len) srcs.push(schedulePiece(ctx, c.buf, inputOf(c.speaker), t0 + t + skip - from, a + skip, len - skip));
        t += len;
      }
    }
    return srcs;
  }

  // Musique : enveloppe programmée sur la ligne de temps, morceau bouclé ou non, arrêt à la fin de la région
  function scheduleMusic(ctx, mc, t0, from) {
    const r = st.musicRegion;
    if (!r || from >= r.end) return [];
    const pts = musicEnvelope();
    const p = mc.env.gain;
    p.cancelScheduledValues(0);
    p.setValueAtTime(envAt(pts, from), t0);
    for (const [t, v] of pts) if (t > from) p.linearRampToValueAtTime(v, t0 + t - from);
    const src = ctx.createBufferSource();
    src.buffer = st.musicBuf;
    src.loop = st.music.loop;
    const into = Math.max(0, from - r.start);
    src.connect(mc.input);
    src.start(t0 + Math.max(0, r.start - from), st.music.loop ? into % st.musicBuf.duration : into);
    src.stop(t0 + r.end - from);
    return [src];
  }

  function play() {
    const ctx = ctxAudio();
    ctx.resume();
    applyMix(false);
    if (st.offset >= st.total) st.offset = 0;
    const now = ctx.currentTime + 0.05;
    st.sources = scheduleVoices(ctx, (k) => chain(k).input, now, st.offset);
    if (hasMusic()) st.sources.push(...scheduleMusic(ctx, musicChain(), now, st.offset));
    st.startedAt = now - st.offset;
    st.playing = true;
    tick();
    refreshControls();
  }

  function pause() {
    st.offset = Math.min(position(), st.total);
    st.playing = false;
    stopSources();
    cancelAnimationFrame(st.raf);
    refreshControls();
    moveCursor();
  }

  function seek(t) {
    const was = st.playing;
    if (was) { st.playing = false; stopSources(); }
    st.offset = Math.max(0, Math.min(t, st.total));
    if (was) play(); else { moveCursor(); refreshControls(); }
  }
  // Après un changement de placement : relance la lecture au même endroit
  const replay = () => { if (st.playing) seek(position()); };

  function tick() {
    cancelAnimationFrame(st.raf);
    const loop = () => {
      if (!st.playing) return;
      if (position() >= st.total) { st.offset = 0; st.playing = false; stopSources(); refreshControls(); moveCursor(); return; }
      moveCursor(true);
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }

  // Curseur et compteur ; pendant la lecture, la vue suit le curseur
  function moveCursor(follow = false) {
    if (!st.els) return;
    const t = position();
    const x = t * st.pps;
    st.els.cursor.style.transform = `translateX(${x}px)`;
    st.els.clock.textContent = `${fmtClock(t)} / ${fmtClock(st.total)}`;
    const sc = st.els.scroll;
    if (follow && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = Math.max(0, x - 80);
  }

  function refreshControls() {
    if (!st.els) return;
    st.els.play.textContent = st.playing ? '❚❚ Pause' : '▶ Lecture';
    st.els.play.setAttribute('aria-pressed', String(st.playing));
  }

  function toggle() { if (st.playing) pause(); else play(); }

  // Espace : lecture / pause (sauf dans un champ de saisie)
  document.addEventListener('keydown', (e) => {
    if (!st.els || !document.body.contains(st.els.root)) return;
    if (e.code !== 'Space' || e.target.closest('input, textarea, select, button')) return;
    e.preventDefault();
    toggle();
  });

  // ---------- Export : même chaîne, rendu hors temps réel ----------
  async function exportWav(btn, normalize) {
    if (!st.clips.some((c) => c.pieces)) { toast('Aucune prise à exporter.', 'error'); return; }
    if (st.playing) pause();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Rendu…';
    try {
      // Stéréo dès qu'une musique est présente (voix au centre), mono sinon
      const stereo = Boolean(st.musicRegion);
      const nch = stereo ? 2 : 1;
      const length = Math.ceil((st.total + 0.05) * SAMPLE_RATE);
      const off = new OfflineAudioContext(nch, length, SAMPLE_RATE);
      const lim = createLimiter(off);
      const chains = {};
      const ir = createImpulse(off);
      for (const k of keys()) { chains[k] = createChain(off, lim, ir); chains[k].apply(st.mix[k], audible(k), false); }
      scheduleVoices(off, (k) => chains[k].input, 0, 0);
      if (stereo) {
        const mc = createMusicChain(off, lim);
        mc.apply(st.music, audible('M'), false);
        scheduleMusic(off, mc, 0, 0);
      }
      const rendered = await off.startRendering();
      const channels = Array.from({ length: nch }, (_, c) => rendered.getChannelData(c));
      // Normalisation facultative : crête (tous canaux) ramenée à -1 dBFS
      if (normalize) {
        let peak = 0;
        for (const data of channels) for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        if (peak > 0) { const g = dbToGain(-1) / peak; for (const data of channels) for (let i = 0; i < data.length; i++) data[i] *= g; }
      }
      const url = URL.createObjectURL(encodeWav(channels, SAMPLE_RATE));
      const base = (st.project.name || 'capsule').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'capsule';
      const a = h('a', { href: url, download: `${base}-montage-${new Date().toISOString().slice(0, 10)}.wav` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Montage exporté (WAV 44,1 kHz ${stereo ? 'stéréo, musique comprise' : 'mono'}, réglages des pistes appliqués).`);
    } catch (e) {
      toast(`Export impossible : ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- Export des répliques séparées : chaque prise traitée comme dans le montage ----------
  // Même chaîne (égaliseur, compresseur, volume, pièce, limiteur) et mêmes coupes, sans la musique ni les silences.
  // Muet / solo ignorés : chaque réplique sort. Normalisation : un seul gain pour toutes (niveaux relatifs gardés).
  async function exportReplies(btn, normalize) {
    const clips = st.clips.filter((c) => c.pieces);
    if (!clips.length) { toast('Aucune prise à exporter.', 'error'); return; }
    if (st.playing) pause();
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const dialogue = st.project.mode === 'dialogue';
      const rendered = [];
      for (const [i, c] of clips.entries()) {
        btn.textContent = `Rendu ${i + 1} / ${clips.length}…`;
        const mix = st.mix[c.speaker];
        // Queue de réverbération gardée quand la pièce est active
        const tail = mix.room > 0 ? 0.6 : 0.05;
        const off = new OfflineAudioContext(1, Math.ceil((c.dur + tail) * SAMPLE_RATE), SAMPLE_RATE);
        const chain = createChain(off, createLimiter(off), createImpulse(off));
        chain.apply(mix, true, false);
        let t = 0;
        for (const [a, b] of c.pieces) { schedulePiece(off, c.buf, chain.input, t, a, b - a); t += b - a; }
        rendered.push({ c, data: (await off.startRendering()).getChannelData(0) });
      }
      if (normalize) {
        let peak = 0;
        for (const { data } of rendered) for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        if (peak > 0) { const g = dbToGain(-1) / peak; for (const { data } of rendered) for (let i = 0; i < data.length; i++) data[i] *= g; }
      }
      const who = (c) => (dialogue ? slugName(st.project.names?.[c.speaker]) || c.speaker : slugName(c.seg.title) || 'segment');
      const files = [];
      const lines = ['numero;fichier;intervenant;debut_dans_le_montage_s;duree_s;texte'];
      for (const [i, { c, data }] of rendered.entries()) {
        const name = `${String(i + 1).padStart(2, '0')}-${who(c)}.wav`;
        files.push({ name, data: new Uint8Array(await encodeWav([data], SAMPLE_RATE).arrayBuffer()) });
        const text = (c.seg.revision?.spokenText ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().replace(/;/g, ',');
        lines.push([i + 1, name, dialogue ? st.project.names?.[c.speaker] || c.speaker : '', c.start.toFixed(2), (data.length / SAMPLE_RATE).toFixed(2), text].join(';'));
      }
      // Repères pour caler les répliques dans un logiciel vidéo (UTF-8 avec BOM pour Excel)
      files.push({ name: 'repliques.csv', data: new TextEncoder().encode('\ufeff' + lines.join('\r\n') + '\r\n') });
      const url = URL.createObjectURL(buildZip(files));
      const base = slugName(st.project.name) || 'capsule';
      const a = h('a', { href: url, download: `${base}-repliques-montage.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`${rendered.length} réplique${rendered.length > 1 ? 's' : ''} exportée${rendered.length > 1 ? 's' : ''} (WAV 44,1 kHz mono, réglages des pistes et coupes appliqués, sans musique).`);
    } catch (e) {
      toast(`Export impossible : ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- Mise à jour légère pendant un glissement ----------
  // Blocs retrouvés par segment : layout() recrée les objets, pas les éléments affichés
  function placeBlocks() {
    for (const x of st.clips) {
      const b = st.clipEls.get(x.seg.id);
      if (b) { b.style.left = `${x.start * st.pps}px`; b.style.width = `${Math.max(4, x.dur * st.pps)}px`; }
    }
  }
  const pauseText = (c) => {
    const p = pauseBefore(c);
    return c.index === 0 ? `Début à ${fmtClock(p)}` : p < 0 ? `Chevauchement de ${(-p).toFixed(2).replace('.', ',')} s avec la réplique précédente` : `Silence de ${p.toFixed(2).replace('.', ',')} s avant cette réplique`;
  };

  // ---------- Déplacement d'un segment à la souris ----------
  // Glisser modifie le décalage du segment (les suivants suivent) ; un simple clic le sélectionne et place le curseur.
  function startDrag(e, c) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const base = st.nudges[c.seg.id] ?? 0;
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) { moved = true; if (st.playing) pause(); el.classList.add('dragging'); }
      const snap = ev.shiftKey ? SNAP_FINE : SNAP;
      const v = Math.round((base + dx / st.pps) / snap) * snap;
      st.nudges[c.seg.id] = Math.max(-60, Math.min(60, ms(v)));
      layout();
      placeBlocks();
      st.els.status.textContent = pauseText(st.clips[c.index]);
      moveCursor();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      if (!moved) { select(c.seg.id); seek(c.start); return; }
      saveMix();
      draw();
      st.els.status.textContent = '';
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // ---------- Rognage du début ou de la fin d'un segment (poignées) ----------
  // Début : l'audio reste en place, le bord gauche avance ; fin : le bord droit recule et les suivants suivent.
  function startTrim(e, c, side) {
    if (e.button !== 0 || !c.buf) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const id = c.seg.id;
    const orig = structuredClone(st.edits[id] ?? { in: 0, out: 0, cuts: [] });
    const durBefore = c.dur;
    const nudgeBefore = st.nudges[id] ?? 0;
    const full = c.buf.duration;
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; if (st.playing) pause(); select(id); }
      const d = Math.round(dx / st.pps / SNAP_FINE) * SNAP_FINE;
      const ed = { ...orig, cuts: orig.cuts };
      if (side === 'in') ed.in = ms(Math.max(0, Math.min(full - orig.out - MIN_CLIP, orig.in + d)));
      else ed.out = ms(Math.max(0, Math.min(full - orig.in - MIN_CLIP, orig.out - d)));
      st.edits[id] = ed;
      // Bord gauche : décalage compensé pour que la suite de l'audio ne bouge pas
      if (side === 'in') st.nudges[id] = Math.max(-60, Math.min(60, ms(nudgeBefore + durBefore - piecesDur(piecesOf(full, ed)))));
      layout();
      placeBlocks();
      const now = st.clips[c.index];
      st.els.status.textContent = side === 'in' ? `Début coupé : ${fmtSec(ed.in, 2)}` : `Fin coupée : ${fmtSec(ed.out, 2)} · durée ${fmtSec(now.dur, 2)}`;
      redrawClip(now);
      moveCursor();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (!moved) return;
      tidyEdit(id);
      saveMix();
      draw();
      st.els.status.textContent = '';
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // Coupe vide retirée (pas de valeur inutile enregistrée)
  function tidyEdit(id) {
    const e = st.edits[id];
    if (e && !e.in && !e.out && !e.cuts.length) delete st.edits[id];
  }

  // ---------- Blancs ----------
  // Remplace les coupes d'un segment par les coupes automatiques ; renvoie le temps gagné
  function shortenClip(c) {
    if (!c.buf) return 0;
    const before = c.dur;
    const ed = autoEdit(c.buf, st.maxPause);
    if (!ed) return 0;
    // Le segment raccourcit, les suivants avancent d'autant
    st.edits[c.seg.id] = ed;
    tidyEdit(c.seg.id);
    return before - piecesDur(piecesOf(c.buf.duration, st.edits[c.seg.id]));
  }

  function shortenSelected() {
    const c = st.clips.find((x) => x.seg.id === st.selected);
    if (!c?.buf) return;
    if (st.playing) pause();
    const gained = shortenClip(c);
    afterEdit();
    toast(gained > 0.01 ? `Segment ${c.index + 1} : ${fmtSec(gained)} de blancs retirés.` : `Segment ${c.index + 1} : aucun blanc de plus de ${fmtSec(st.maxPause)}.`);
  }

  function shortenAll() {
    if (st.playing) pause();
    let gained = 0;
    let count = 0;
    for (const c of st.clips) {
      const g = shortenClip(c);
      if (g > 0.01) { gained += g; count++; }
      // Les segments suivants partent des nouvelles durées
      layout();
    }
    afterEdit();
    toast(count ? `${fmtSec(gained)} de blancs retirés sur ${count} segment${count > 1 ? 's' : ''}.` : `Aucun blanc de plus de ${fmtSec(st.maxPause)}.`);
  }

  function restoreSelected() {
    const id = st.selected;
    const ed = st.edits[id];
    if (!ed) return;
    if (st.playing) pause();
    delete st.edits[id];
    afterEdit();
    toast('Prise entière rétablie pour ce segment.');
  }

  function afterEdit() {
    layout();
    st.offset = Math.min(st.offset, st.total);
    saveMix(true);
    draw();
  }

  // ---------- Sélection d'un segment ----------
  function select(id) {
    st.selected = id;
    for (const [sid, b] of st.clipEls) b.classList.toggle('selected', sid === id);
    renderSegBar();
  }

  // Barre du segment sélectionné : durée, coupes, actions
  function renderSegBar() {
    if (!st.els) return;
    const c = st.clips.find((x) => x.seg.id === st.selected);
    if (!c) {
      fill(st.els.segBar, h('span', { class: 'muted small' }, 'Cliquez sur un segment pour raccourcir ses blancs ou rétablir la prise entière. Tirez ses bords pour couper le début ou la fin.'));
      return;
    }
    const ed = st.edits[c.seg.id];
    const cutTotal = c.buf ? c.buf.duration - c.dur : 0;
    fill(st.els.segBar,
      h('span', { class: `spk spk-${c.speaker}` }, c.speaker),
      h('b', {}, `${c.index + 1}. ${c.seg.title || 'Segment'}`),
      h('span', { class: 'muted small' }, c.buf ? `${fmtSec(c.dur)}${cutTotal > 0.01 ? ` · ${fmtSec(cutTotal)} coupés${ed?.cuts.length ? ` (${ed.cuts.length} blanc${ed.cuts.length > 1 ? 's' : ''})` : ''}` : ''}` : 'aucune prise retenue'),
      h('button', { type: 'button', class: 'btn small', disabled: !c.buf, onclick: shortenSelected, title: `Ramène chaque pause de plus de ${fmtSec(st.maxPause)} à ${fmtSec(st.maxPause)} et coupe les silences du début et de la fin` }, '✂ Raccourcir ses blancs'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !ed, onclick: restoreSelected }, '↺ Prise entière'));
  }

  // ---------- Musique ----------
  async function uploadMusic(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { toast('Fichier trop volumineux (100 Mo maximum).', 'error'); return; }
    const project = st.project;
    st.els.status.textContent = `Envoi de « ${file.name} »…`;
    try {
      const res = await fetch(`/api/v1/projects/${project.id}/music`, {
        method: 'POST',
        headers: { 'X-Capsule-CSRF': '1', 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `Erreur ${res.status}`);
      project.music = data.music;
      if (st.playing) pause();
      st.els.status.textContent = 'Décodage de la musique…';
      await decodeMusic();
      if (!st.els) return;
      st.els.status.textContent = '';
      layout();
      draw();
      toast(`Musique « ${data.music.name} » ajoutée.`);
    } catch (e) {
      if (st.els) st.els.status.textContent = '';
      toast(`Musique non ajoutée : ${e.message}`, 'error');
    }
  }

  async function removeMusic() {
    const project = st.project;
    try {
      const res = await app.api('POST', `/api/v1/projects/${project.id}/music/remove`);
      if (st.playing) pause();
      project.music = res.music;
      await decodeMusic();
      layout();
      st.offset = Math.min(st.offset, st.total);
      draw();
      toast('Musique retirée (votre fichier d’origine n’est pas touché).');
    } catch (e) { toast(`Musique non retirée : ${e.message}`, 'error'); }
  }

  // Choix d'un fichier audio (champ caché)
  function pickMusic() {
    const input = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.flac,.m4a' });
    input.addEventListener('change', () => uploadMusic(input.files[0]));
    input.click();
  }

  // Bloc de la musique : forme d'onde, courbe de volume, glissable pour changer son départ
  function musicLane() {
    const r = st.musicRegion;
    if (!hasMusic()) {
      return h('div', { class: 'mt-lane mt-music-lane', style: `height:${MUSIC_EMPTY_H}px` },
        h('button', { type: 'button', class: 'mt-music-drop', onclick: (e) => { e.stopPropagation(); pickMusic(); } }, '♪ Ajouter une musique de fond (WAV, MP3, OGG, FLAC, M4A)'));
    }
    if (!r) return h('div', { class: 'mt-lane mt-music-lane', style: `height:${LANE_H}px` }, h('p', { class: 'muted small mt-music-wait' }, 'Chargement de la musique…'));
    const canvas = h('canvas', { class: 'mt-wave', 'aria-hidden': 'true' });
    const block = h('div', {
      class: 'mt-clip mt-music-clip',
      style: `left:${r.start * st.pps}px;width:${Math.max(4, (r.end - r.start) * st.pps)}px`,
      title: 'Glisser : changer le départ de la musique · la ligne indique son volume (fondus et baisse sous les voix)',
      role: 'button', tabindex: '0',
      'aria-label': `Musique à partir de ${fmtClock(r.start)}`,
      onclick: (e) => e.stopPropagation(),
      onpointerdown: (e) => startMusicDrag(e)
    }, h('span', { class: 'mt-clip-title' }, `♪ ${st.project.music.name}`), canvas);
    st.els.musicBlock = block;
    requestAnimationFrame(() => redrawMusic());
    return h('div', { class: 'mt-lane mt-music-lane', style: `height:${LANE_H}px` }, block);
  }

  function redrawMusic() {
    const block = st.els?.musicBlock;
    const r = st.musicRegion;
    if (!block || !r) return;
    const css = getComputedStyle(document.documentElement);
    const env = musicEnvelope().map(([t, v]) => [t - r.start, v]);
    drawWave(block.querySelector('canvas'), st.musicBuf, css.getPropertyValue('--gold').trim(), musicPieces(), { env, envColor: css.getPropertyValue('--text').trim() });
  }

  function startMusicDrag(e) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const base = st.music.start;
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) { moved = true; if (st.playing) pause(); el.classList.add('dragging'); }
      const snap = ev.shiftKey ? SNAP_FINE : 0.1;
      st.music.start = Math.max(0, ms(Math.round((base + dx / st.pps) / snap) * snap));
      layout();
      el.style.left = `${st.musicRegion.start * st.pps}px`;
      el.style.width = `${(st.musicRegion.end - st.musicRegion.start) * st.pps}px`;
      st.els.status.textContent = `Musique à partir de ${fmtClock(st.music.start)}`;
      redrawMusic();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      if (!moved) { seek((e.clientX - el.parentElement.getBoundingClientRect().left) / st.pps); return; }
      saveMix();
      draw();
      st.els.status.textContent = '';
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // ---------- Affichage ----------
  // Curseur de réglage : onInput à chaque mouvement, onCommit au relâchement (facultatif)
  function slider(id, label, min, max, step, value, onInput, fmt, onCommit) {
    const out = h('output', { for: id }, fmt(value));
    const input = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(value), title: 'Double-clic : valeur par défaut' });
    input.addEventListener('input', () => { onInput(Number(input.value)); out.textContent = fmt(Number(input.value)); });
    if (onCommit) input.addEventListener('change', onCommit);
    return { el: h('div', { class: 'mt-ctl' }, h('label', { for: id }, label), input, out), input };
  }
  const resettable = ({ el, input }, def) => {
    input.addEventListener('dblclick', () => { input.value = String(def); input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); });
    return el;
  };

  // Tranche de console d'une piste : nom, muet/solo, volume, égaliseur, compresseur
  function strip(k) {
    const p = st.project;
    const dialogue = p.mode === 'dialogue';
    const m = st.mix[k];
    const v = app.voice(dialogue ? p.voices[k] : app.monoVoiceId());
    const changed = () => { saveMix(); applyMix(); };
    const sl = (id, label, min, max, step, value, set, fmt) => resettable(slider(id, label, min, max, step, value, (x) => { set(x); changed(); }, fmt), 0);
    const comp = h('input', { type: 'checkbox', id: `mt-comp-${k}`, checked: m.comp });
    comp.addEventListener('change', () => { m.comp = comp.checked; changed(); });
    return h('div', { class: `mt-label ${audible(k) ? '' : 'silent'}`, style: `height:${LANE_H}px`, dataset: { track: k } },
      h('div', { class: 'mt-strip-head' },
        h('span', { class: `spk spk-${k}` }, k),
        h('div', { class: 'mt-strip-name' }, h('b', {}, dialogue ? (p.names[k] || `Intervenant ${k}`) : 'Voix'),
          h('div', { class: 'muted small' }, v?.name ?? 'voix non choisie')),
        muteSolo(k),
        h('button', { type: 'button', class: 'mt-ms', title: 'Remettre la piste à plat', 'aria-label': 'Remettre la piste à plat', onclick: () => {
          st.mix[k] = { ...DEFAULT_TRACK_MIX };
          changed();
          draw();
        } }, '↺')),
      sl(`mt-vol-${k}`, 'Volume', -24, 6, 0.5, m.volume, (x) => { m.volume = x; }, fmtDb),
      h('div', { class: 'mt-eq' }, EQ_BANDS.map((b) => sl(`mt-${b.key}-${k}`, b.label, -12, 12, 1, m[b.key], (x) => { m[b.key] = x; }, (x) => `${x > 0 ? '+' : ''}${x}`))),
      sl(`mt-room-${k}`, 'Pièce', 0, 100, 5, Math.round(m.room * 100), (x) => { m.room = x / 100; }, (x) => `${x} %`),
      h('label', { class: 'check mt-comp', for: `mt-comp-${k}` }, comp, 'Compresseur (niveaux plus réguliers)'));
  }

  // Boutons muet / solo d'une piste (voix ou musique)
  function muteSolo(k) {
    const m = mixOf(k);
    const btn = (label, title, prop) => h('button', {
      type: 'button', class: `mt-ms ${prop}`, title, 'aria-pressed': String(m[prop]),
      onclick: (e) => { m[prop] = !m[prop]; e.currentTarget.setAttribute('aria-pressed', String(m[prop])); saveMix(); applyMix(); refreshStrips(); }
    }, label);
    return [btn('M', 'Muet', 'mute'), btn('S', 'Solo : n’écouter que cette piste', 'solo')];
  }

  // Tranche de la musique : volume, baisse sous les voix, fondus, fin, boucle, fichier
  function musicStrip() {
    if (!hasMusic()) {
      return h('div', { class: 'mt-label', style: `height:${MUSIC_EMPTY_H}px` },
        h('div', { class: 'mt-strip-head' }, h('span', { class: 'spk spk-M' }, '♪'), h('div', { class: 'mt-strip-name' }, h('b', {}, 'Musique'), h('div', { class: 'muted small' }, 'aucune'))));
    }
    const m = st.music;
    // Volume : effet immédiat ; placement et courbe : redessin, puis relance de la lecture au relâchement
    const live = () => { saveMix(); applyMix(); };
    const shape = () => { saveMix(); layout(); refreshMusic(); };
    const sec = (x) => fmtSec(x);
    const sl = (id, label, min, max, step, value, set, fmt, def, onShape) => resettable(slider(id, label, min, max, step, value, (x) => { set(x); (onShape ? shape : live)(); }, fmt, onShape ? replay : null), def);
    const loop = h('input', { type: 'checkbox', id: 'mt-music-loop', checked: m.loop });
    loop.addEventListener('change', () => { m.loop = loop.checked; shape(); replay(); });
    return h('div', { class: `mt-label ${audible('M') ? '' : 'silent'}`, style: `height:${LANE_H}px`, dataset: { track: 'M' } },
      h('div', { class: 'mt-strip-head' },
        h('span', { class: 'spk spk-M' }, '♪'),
        h('div', { class: 'mt-strip-name' }, h('b', {}, 'Musique'), h('div', { class: 'muted small', title: st.project.music.name }, st.project.music.name)),
        muteSolo('M'),
        h('button', { type: 'button', class: 'mt-ms', title: 'Réglages de la musique par défaut', 'aria-label': 'Réglages de la musique par défaut', onclick: () => {
          st.music = { ...DEFAULT_MUSIC_MIX, start: st.music.start };
          saveMix(); layout(); applyMix(); replay(); draw();
        } }, '↺')),
      sl('mt-mvol', 'Volume', -40, 6, 0.5, m.volume, (x) => { m.volume = x; }, fmtDb, DEFAULT_MUSIC_MIX.volume),
      sl('mt-duck', 'Sous voix', 0, 30, 1, m.duck, (x) => { m.duck = x; }, (x) => (x ? `-${x} dB` : 'non'), DEFAULT_MUSIC_MIX.duck, true),
      h('div', { class: 'mt-eq' },
        sl('mt-fin', 'Entrée', 0, 15, 0.5, m.fadeIn, (x) => { m.fadeIn = x; }, sec, DEFAULT_MUSIC_MIX.fadeIn, true),
        sl('mt-fout', 'Sortie', 0, 15, 0.5, m.fadeOut, (x) => { m.fadeOut = x; }, sec, DEFAULT_MUSIC_MIX.fadeOut, true),
        sl('mt-tail', 'Après voix', 0, 30, 0.5, m.tail, (x) => { m.tail = x; }, sec, DEFAULT_MUSIC_MIX.tail, true)),
      h('div', { class: 'mt-music-row' },
        h('label', { class: 'check mt-comp', for: 'mt-music-loop' }, loop, 'Boucle'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: pickMusic }, 'Remplacer…'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: removeMusic }, 'Retirer')));
  }

  // Musique redessinée sans reconstruire les tranches (le curseur en cours de réglage reste actif)
  function refreshMusic() {
    if (!st.els?.musicBlock || !st.musicRegion) return;
    const r = st.musicRegion;
    st.els.musicBlock.style.left = `${r.start * st.pps}px`;
    st.els.musicBlock.style.width = `${(r.end - r.start) * st.pps}px`;
    st.els.inner.style.width = `${innerWidth()}px`;
    redrawMusic();
    moveCursor();
  }

  // Grise les pistes rendues muettes par muet/solo
  function refreshStrips() {
    if (!st.els) return;
    st.els.labels.querySelectorAll('[data-track]').forEach((el) => el.classList.toggle('silent', !audible(el.dataset.track)));
  }

  const innerWidth = () => Math.max(st.els.scroll.clientWidth - 2, Math.ceil(st.total * st.pps) + 120);
  const musicH = () => (hasMusic() ? LANE_H : MUSIC_EMPTY_H);

  // Bloc d'un segment : titre, forme d'onde (coupes appliquées), poignées de rognage
  function redrawClip(c) {
    const block = st.clipEls.get(c.seg.id);
    const canvas = block?.querySelector('canvas');
    if (!canvas || !c.buf) return;
    const css = getComputedStyle(document.documentElement);
    const color = c.speaker === 'B' ? css.getPropertyValue('--speaker-b').trim() : css.getPropertyValue('--accent').trim();
    // Raccords des blancs retirés (hors début et fin)
    const marks = [];
    let t = 0;
    c.pieces.forEach(([a, b], i) => { if (i) marks.push(t); t += b - a; });
    drawWave(canvas, c.buf, color, c.pieces, { marks, envColor: css.getPropertyValue('--muted').trim() });
  }

  function draw() {
    const els = st.els;
    const ks = keys();
    const width = innerWidth();
    els.musicBlock = null;

    fill(els.labels, h('div', { class: 'mt-label-ruler', style: `height:${RULER_H}px` }), ks.map(strip), musicStrip());

    // Règle graduée : un repère par seconde, une étiquette toutes les 5 ou 10 s
    const labelEvery = st.pps >= 60 ? 5 : 10;
    const ticks = [];
    for (let s = 0; s <= st.total + 1; s++) {
      ticks.push(h('span', { class: `mt-tick ${s % labelEvery === 0 ? 'major' : ''}`, style: `left:${s * st.pps}px` }, s % labelEvery === 0 ? fmtClock(s).replace(/,0$/, '') : ''));
    }
    const ruler = h('div', { class: 'mt-ruler', style: `height:${RULER_H}px` }, ticks);

    st.clipEls.clear();
    const lanes = ks.map((k) => h('div', { class: 'mt-lane', style: `height:${LANE_H}px` },
      st.clips.filter((c) => c.speaker === k).map((c) => {
        const canvas = c.take ? h('canvas', { class: 'mt-wave', 'aria-hidden': 'true' }) : null;
        const cut = st.edits[c.seg.id];
        const block = h('div', {
          class: `mt-clip spk-bg-${k} ${c.take ? '' : 'missing'} ${st.selected === c.seg.id ? 'selected' : ''} ${cut ? 'edited' : ''}`,
          style: `left:${c.start * st.pps}px;width:${Math.max(4, c.dur * st.pps)}px`,
          title: `${c.index + 1}. ${c.seg.title || 'Segment'}${c.take ? '' : ' · aucune prise retenue'}${cut ? ' · coupé' : ''} · double-clic pour l’ouvrir dans le Studio`,
          role: 'button', tabindex: '0',
          'aria-label': `Segment ${c.index + 1}, ${c.seg.title || 'sans titre'}, à ${fmtClock(c.start)}`,
          onclick: (e) => e.stopPropagation(),
          onpointerdown: (e) => startDrag(e, c),
          ondblclick: (e) => { e.stopPropagation(); pause(); app.openSegment(c.seg.id); },
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); select(c.seg.id); seek(c.start); } }
        },
        h('span', { class: 'mt-clip-title' }, `${c.index + 1}. ${c.seg.title || 'Segment'}`),
        canvas,
        // Poignées de rognage (prise décodée seulement)
        c.buf ? h('span', { class: 'mt-handle in', title: 'Tirer : couper le début', onpointerdown: (e) => startTrim(e, c, 'in'), ondblclick: (e) => e.stopPropagation() }) : null,
        c.buf ? h('span', { class: 'mt-handle out', title: 'Tirer : couper la fin', onpointerdown: (e) => startTrim(e, c, 'out'), ondblclick: (e) => e.stopPropagation() }) : null);
        st.clipEls.set(c.seg.id, block);
        if (canvas) requestAnimationFrame(() => redrawClip(c));
        return block;
      })));

    // Clic sur la règle ou une piste vide : déplacement du curseur
    const inner = h('div', { class: 'mt-inner', style: `width:${width}px`, onclick: (e) => {
      const r = inner.getBoundingClientRect();
      seek((e.clientX - r.left) / st.pps);
    } }, ruler, lanes, musicLane(), els.cursor);
    els.inner = inner;
    fill(els.scroll, inner);
    els.cursor.style.height = `${RULER_H + ks.length * LANE_H + musicH()}px`;
    renderSegBar();
    moveCursor();
  }

  async function render(view) {
    const project = app.project();
    if (!project) { fill(view, h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Aucun projet ouvert.'))); return; }
    if (st.playing) pause();
    // Changement de projet : position et sélection remises à zéro
    if (st.project?.id !== project.id) { st.offset = 0; st.selected = null; }
    st.project = project;
    loadMix();
    st.pps = Number(store.get('cs.montage.zoom', '60'));
    if (!ZOOMS.includes(st.pps)) st.pps = 60;
    // Musique d'un autre projet : oubliée
    if (st.musicKey && !st.musicKey.startsWith(`${project.id}:`)) { st.musicBuf = null; st.musicKey = null; }
    layout();
    st.offset = Math.min(st.offset, st.total);

    const play = h('button', { type: 'button', class: 'btn primary', 'aria-pressed': 'false', onclick: toggle }, '▶ Lecture');
    const toStart = h('button', { type: 'button', class: 'btn ghost', title: 'Revenir au début', 'aria-label': 'Revenir au début', onclick: () => seek(0) }, '⏮');
    const clock = h('span', { class: 'mt-clock', 'aria-live': 'off' });
    // Silence par défaut ; une valeur hors liste (ancienne) reste proposée
    const gaps = GAPS.includes(st.gap) ? GAPS : [...GAPS, st.gap].sort((a, b) => a - b);
    const gapSel = h('select', { id: 'mt-gap' }, gaps.map((g) => h('option', { value: String(g), selected: g === st.gap }, g ? `${String(g).replace('.', ',')} s` : 'Aucun')));
    gapSel.addEventListener('change', () => {
      st.gap = Number(gapSel.value);
      saveMix();
      const t = position();
      if (st.playing) pause();
      layout();
      st.offset = Math.min(t, st.total);
      draw();
    });
    const zoomSel = h('select', { id: 'mt-zoom' }, ZOOMS.map((z) => h('option', { value: String(z), selected: z === st.pps }, `${Math.round((z / 60) * 100)} %`)));
    zoomSel.addEventListener('change', () => { st.pps = Number(zoomSel.value); store.set('cs.montage.zoom', String(st.pps)); draw(); });
    // Pause gardée par « Raccourcir les blancs »
    const pauses = PAUSES.includes(st.maxPause) ? PAUSES : [...PAUSES, st.maxPause].sort((a, b) => a - b);
    const pauseSel = h('select', { id: 'mt-pause', title: 'Durée à laquelle sont ramenées les pauses trop longues' }, pauses.map((p) => h('option', { value: String(p), selected: p === st.maxPause }, fmtSec(p))));
    pauseSel.addEventListener('change', () => { st.maxPause = Number(pauseSel.value); saveMix(); renderSegBar(); });
    const shortenAllBtn = h('button', { type: 'button', class: 'btn small', title: 'Raccourcir les blancs de tous les segments (remplace leurs coupes)', onclick: shortenAll }, '✂ Tous les segments');
    const norm = h('input', { type: 'checkbox', id: 'mt-norm', checked: store.get('cs.montage.norm', '1') === '1' });
    norm.addEventListener('change', () => store.set('cs.montage.norm', norm.checked ? '1' : '0'));
    const exportBtn = h('button', { type: 'button', class: 'btn', onclick: () => exportWav(exportBtn, norm.checked) }, '⤓ Exporter le montage (WAV)');
    // Une réplique par fichier (HeyGen, logiciel vidéo) : même traitement que le montage
    const repliesBtn = h('button', { type: 'button', class: 'btn', title: 'Un fichier WAV par réplique, traité comme le montage (sans musique), avec un tableau des repères', onclick: () => exportReplies(repliesBtn, norm.checked) }, '⤓ Répliques séparées (ZIP)');
    const status = h('p', { class: 'muted small', role: 'status' });
    const resetMoves = h('button', { type: 'button', class: 'btn small ghost', title: 'Annuler tous les déplacements de segments', onclick: () => {
      if (!Object.keys(st.nudges).length) return;
      if (st.playing) pause();
      st.nudges = {};
      layout();
      st.offset = Math.min(st.offset, st.total);
      saveMix(true);
      draw();
      toast('Segments remis à leur place d’origine.');
    } }, '↺ Replacer les segments');
    const missing = st.clips.filter((c) => !c.take).length;

    st.els = {
      root: h('section', { class: 'card montage' }),
      labels: h('div', { class: 'mt-labels' }),
      scroll: h('div', { class: 'mt-scroll' }),
      cursor: h('div', { class: 'mt-cursor', 'aria-hidden': 'true' }),
      segBar: h('div', { class: 'mt-segbar', 'aria-live': 'polite' }),
      inner: null, musicBlock: null,
      play, clock, status
    };
    fill(st.els.root,
      h('div', { class: 'mt-head' },
        h('h2', {}, `Montage · ${project.name}`),
        h('div', { class: 'mt-transport' }, toStart, play, clock),
        h('div', { class: 'mt-opts' },
          h('label', { for: 'mt-gap' }, 'Silence entre répliques'), gapSel,
          h('label', { for: 'mt-zoom' }, 'Zoom'), zoomSel, resetMoves)),
      h('div', { class: 'mt-opts mt-blanks' },
        h('label', { for: 'mt-pause' }, 'Blancs : ramener les pauses à'), pauseSel, shortenAllBtn),
      missing ? h('p', { class: 'blocked' }, `${missing} segment${missing > 1 ? 's' : ''} sans prise retenue : en pointillés, non joué${missing > 1 ? 's' : ''}.`) : null,
      st.els.segBar,
      h('div', { class: 'mt-body' }, st.els.labels, st.els.scroll),
      h('div', { class: 'mt-foot' },
        h('div', { class: 'row' }, exportBtn, repliesBtn,
          h('label', { class: 'check', for: 'mt-norm' }, norm, 'Normaliser (crête à -1 dB)')),
        status),
      h('p', { class: 'muted small' }, 'Espace : lecture / pause · clic : placer le curseur et sélectionner un segment · glisser un segment : le déplacer, les suivants suivent (Maj : réglage fin), vers la gauche il chevauche la réplique précédente · tirer le bord d’un segment : couper son début ou sa fin · double-clic sur un segment : l’ouvrir dans le Studio · double-clic sur un curseur de réglage : valeur par défaut. La musique baisse automatiquement pendant les voix (« Sous voix ») ; la ligne claire sur sa forme d’onde montre son volume. Les réglages s’entendent en direct, sont appliqués à l’export (stéréo avec musique) et sont enregistrés avec le projet. Un limiteur général évite toute saturation.'));
    fill(view, st.els.root);
    draw();

    // Décodage puis redessin avec les vraies durées et formes d'onde
    const needVoices = st.clips.some((c) => c.take && !st.buffers.has(c.take.id));
    const needMusic = hasMusic() && st.musicKey !== `${project.id}:${project.music.uploadedAt}`;
    if (needVoices || needMusic) {
      play.disabled = true;
      exportBtn.disabled = true;
      await decodeAll((n, total) => { status.textContent = `Chargement des prises… ${n} / ${total}`; });
      if (needMusic) { status.textContent = 'Chargement de la musique…'; await decodeMusic(); }
      if (!st.els || !document.body.contains(st.els.root)) return;
      status.textContent = '';
      play.disabled = false;
      exportBtn.disabled = false;
      layout();
      draw();
    }
  }

  // Quitter la page : lecture arrêtée, éléments oubliés
  function leave() {
    if (st.playing) pause();
    st.els = null;
  }

  return { render, leave };
}
