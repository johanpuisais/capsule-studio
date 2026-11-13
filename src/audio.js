// Parseurs audio locaux (sans service externe) : validation et durée réelle.

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Lecture d'un en-tête de trame MPEG Layer III à la position i
function readFrame(buf, i) {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (buf[i + 1] >> 1) & 0x03; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
  const srIdx = (buf[i + 2] >> 2) & 0x03;
  if (srIdx === 3) return null;
  const padding = (buf[i + 2] >> 1) & 0x01;
  const channels = ((buf[i + 3] >> 6) & 0x03) === 3 ? 1 : 2;
  const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
  if (!kbps) return null;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  return { length, samples, sampleRate, channels, kbps };
}

// Analyse d'un MP3 : au moins 3 trames consécutives valides exigées
export function parseMp3(buf) {
  let i = 0;
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  // Recherche de la première trame (tolère quelques octets de bourrage)
  const searchLimit = Math.min(buf.length, i + 4096);
  while (i < searchLimit && !readFrame(buf, i)) i++;
  let frames = 0;
  let seconds = 0;
  let first = null;
  while (i < buf.length) {
    const f = readFrame(buf, i);
    if (!f || f.length < 4) break;
    if (!first) first = f;
    // Dernière trame tronquée : on s'arrête
    if (i + f.length > buf.length) break;
    frames++;
    seconds += f.samples / f.sampleRate;
    i += f.length;
  }
  if (frames < 3 || !first) return { valid: false };
  return {
    valid: true,
    format: 'mp3',
    frames,
    durationSec: Math.round(seconds * 100) / 100,
    sampleRate: first.sampleRate,
    channels: first.channels,
    bitrateKbps: first.kbps
  };
}

// Analyse d'un WAV (RIFF/WAVE, chunks fmt + data)
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return { valid: false };
  }
  let i = 12;
  let fmt = null;
  let dataSize = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 24 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(i + 10), sampleRate: buf.readUInt32LE(i + 12), byteRate: buf.readUInt32LE(i + 16) };
    } else if (id === 'data') {
      dataSize = Math.min(size, buf.length - i - 8);
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (!fmt || dataSize === null || !fmt.byteRate) return { valid: false };
  return {
    valid: true,
    format: 'wav',
    durationSec: Math.round((dataSize / fmt.byteRate) * 100) / 100,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels
  };
}

// WAV reçu en flux : tailles RIFF/data recalculées pour les logiciels de montage
export function finalizeWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return buf;
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') {
      const out = Buffer.from(buf);
      out.writeUInt32LE(out.length - 8, 4);
      out.writeUInt32LE(out.length - (i + 8), i + 4);
      return out;
    }
    if (size > buf.length) break;
    i += 8 + size + (size % 2);
  }
  return buf;
}

// Détection par signature (jamais par l'extension seule)
export function analyzeAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { valid: false };
  if (buf.toString('latin1', 0, 4) === 'RIFF') return parseWav(buf);
  return parseMp3(buf);
}

// Lecture des données PCM d'un WAV : format + octets audio bruts
function readPcm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let i = 12;
  let fmt = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 24 <= buf.length) {
      fmt = { audioFormat: buf.readUInt16LE(i + 8), channels: buf.readUInt16LE(i + 10), sampleRate: buf.readUInt32LE(i + 12), bitsPerSample: buf.readUInt16LE(i + 22) };
    } else if (id === 'data') {
      if (!fmt) return null;
      return { fmt, data: buf.subarray(i + 8, Math.min(buf.length, i + 8 + size)) };
    }
    i += 8 + size + (size % 2);
  }
  return null;
}

// Assemblage de plusieurs WAV PCM identiques (fréquence, canaux, bits) en un seul,
// avec un silence optionnel entre chaque. Renvoie { wav } ou { error, index }.
export function concatWav(buffers, gapSec = 0) {
  const parts = buffers.map(readPcm);
  const bad = parts.findIndex((p) => !p || p.fmt.audioFormat !== 1);
  if (bad !== -1) return { error: 'not_pcm_wav', index: bad };
  const ref = parts[0].fmt;
  const diff = parts.findIndex((p) => p.fmt.channels !== ref.channels || p.fmt.sampleRate !== ref.sampleRate || p.fmt.bitsPerSample !== ref.bitsPerSample);
  if (diff !== -1) return { error: 'format_mismatch', index: diff };
  const blockAlign = ref.channels * (ref.bitsPerSample / 8);
  // Silence aligné sur un bloc complet (zéros = silence en PCM signé 16 bits)
  const gap = Buffer.alloc(Math.round(gapSec * ref.sampleRate) * blockAlign);
  // Données arrondies à un bloc complet pour ne pas décaler les échantillons
  const chunks = [];
  parts.forEach((p, i) => {
    if (i > 0 && gap.length) chunks.push(gap);
    chunks.push(p.data.subarray(0, p.data.length - (p.data.length % blockAlign)));
  });
  const dataSize = chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ref.channels, 22);
  header.writeUInt32LE(ref.sampleRate, 24);
  header.writeUInt32LE(ref.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(ref.bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize, 40);
  return { wav: Buffer.concat([header, ...chunks]) };
}
