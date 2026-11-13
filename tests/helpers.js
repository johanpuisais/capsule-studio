// Outils de test : faux client Fish Audio et fixtures audio SYNTHÉTIQUES (silence),
// clairement étiquetées comme fichiers de test, jamais présentées comme des sorties Fish Audio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ProviderError } from '../src/fish.js';

export const SENTINEL_KEY = 'SENTINELLE-CLE-FISH-0123456789abcdef';

// MP3 de test : trames MPEG1 Layer III 128 kbit/s 44,1 kHz mono, contenu nul (silence)
export function fixtureMp3(frames = 100) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0xc0;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

// WAV de test : PCM 16 bits mono 16 kHz, silence de la durée demandée
export function fixtureWav(seconds) {
  const sampleRate = 16000;
  const dataSize = Math.round(seconds * sampleRate) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(dataSize, 40);
  return b;
}

// WAV de test « parole » : bips de 220 Hz séparés de pauses (0,4 s en tête, 1,4 s, 0,2 s, 0,6 s en queue),
// PCM 16 bits mono 44,1 kHz, durée 4,7 s ; SYNTHÉTIQUE, pour tester le raccourcissement des blancs
export function fixtureSpeechWav() {
  const sampleRate = 44100;
  const plan = [[0.4, 0], [0.8, 1], [1.4, 0], [0.8, 1], [0.2, 0], [0.5, 1], [0.6, 0]];
  const total = Math.round(plan.reduce((s, [d]) => s + d, 0) * sampleRate);
  const b = fixtureWav(total / 16000);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  let i = 0;
  for (const [d, on] of plan) {
    for (const end = i + Math.round(d * sampleRate); i < end; i++) {
      if (on) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 12000), 44 + i * 2);
    }
  }
  return b;
}

// Faux client Fish Audio : enregistre chaque appel, comportement paramétrable
export function fakeFish(overrides = {}) {
  const calls = { tts: [], getVoice: [], createVoice: [] };
  const voices = new Map([['voix-test-1', { id: 'voix-test-1', type: 'tts', title: 'Test', state: 'trained', visibility: 'private', takenDown: false }]]);
  const client = {
    configured: true,
    calls,
    voices,
    async tts(args) {
      calls.tts.push(args);
      args.onSent?.();
      if (overrides.tts) return overrides.tts(args, calls.tts.length);
      args.onFirstByte?.();
      // Fixture du format demandé (WAV par défaut, MP3 sur demande)
      return args.body?.format === 'wav'
        ? { httpStatus: 200, contentType: 'audio/wav', audio: fixtureWav(2.6), ttfbMs: 5, totalMs: 10 }
        : { httpStatus: 200, contentType: 'audio/mpeg', audio: fixtureMp3(), ttfbMs: 5, totalMs: 10 };
    },
    async getVoice(id) {
      calls.getVoice.push(id);
      if (overrides.getVoice) return overrides.getVoice(id);
      const v = voices.get(id);
      if (!v) throw new ProviderError('not_found', 'Ressource introuvable chez Fish Audio.', { httpStatus: 404 });
      return v;
    },
    // Clé modifiable depuis Réglages (vérifiée par listOwnVoices)
    apiKey: null,
    setApiKey(k) { client.apiKey = k; },
    async listOwnVoices() {
      if (overrides.listOwnVoices) return overrides.listOwnVoices(client.apiKey);
      return { total: voices.size, items: [...voices.values()] };
    },
    async searchVoices(args) {
      calls.search = [...(calls.search ?? []), args];
      return overrides.searchVoices ? overrides.searchVoices(args) : { total: 0, items: [] };
    },
    async createVoice(args) {
      calls.createVoice.push(args);
      const id = `clone-${calls.createVoice.length}`;
      voices.set(id, { id, type: 'tts', title: args.title, state: 'trained', visibility: overrides.cloneVisibility ?? 'private', takenDown: false });
      return { id };
    }
  };
  return client;
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-test-'));
}

export function testConfig(extra = {}) {
  return loadConfig({ DATA_DIR: tempDir(), PORT: '0', FISH_API_KEY: SENTINEL_KEY, CAPSULE_AGENT_TOKEN: '', LAN: 'false', ...extra });
}

// Application complète en mémoire, sans écoute réseau
export function makeApp({ config = testConfig(), fish = fakeFish() } = {}) {
  const app = createApp({ config, fishClient: fish });
  return { app, fish, services: app.services, store: app.store, config };
}

export const OWNER = { role: 'owner' };
export const AGENT = { role: 'agent' };

// Prépare un projet, un segment et une voix prête
export async function seed(services, text = 'Il reste une copie. On peut encore tout récupérer.') {
  const project = services.createProject(OWNER, { name: 'Projet test' });
  const segment = services.createSegment(OWNER, project.id, { title: 'Accroche', spokenText: text, instruction: '[calm]' });
  const voice = await services.importVoice(OWNER, { name: 'Voix test', referenceId: 'voix-test-1', rightsConfirmed: true });
  return { project, segment, voice };
}

// Plan + approbation + exécution, puis attente de la fin du worker
export async function generateOnce(services, { segmentId, voiceId, instruction, key = `cle-${Math.random()}` }) {
  const plan = services.createPlan(OWNER, { segmentId, voiceId, modelKey: 's21_free', instruction });
  services.approvePlan(OWNER, plan.id);
  const { job } = services.executePlan(OWNER, { planId: plan.id, idempotencyKey: key });
  await services.worker.kick();
  return services.getGeneration(job.id);
}
