// Banc d'essai de l'interface : serveur avec FAUX client Fish Audio (silence synthétique).
// Sert uniquement à tester l'interface ; jamais utilisé pour la vidéo ni présenté comme une sortie Fish Audio.
// Usage : node tests/tools/ui-harness.js <port> <dossier-données>
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { fakeFish } from '../helpers.js';

const [port, dataDir] = process.argv.slice(2);
// NO_KEY=1 : premier lancement sans clé Fish (la clé saisie dans Réglages est acceptée par le faux client)
const config = loadConfig({ PORT: port, DATA_DIR: dataDir, FISH_API_KEY: process.env.NO_KEY ? '' : 'cle-de-test-harnais' });
const fish = fakeFish({
  // Délai artificiel pour observer les états dans l'interface
  tts: async (args) => {
    await new Promise((r) => setTimeout(r, 600));
    args.onFirstByte?.();
    await new Promise((r) => setTimeout(r, 400));
    const { fixtureMp3, fixtureWav, fixtureSpeechWav } = await import('../helpers.js');
    // HARNESS_SPEECH=1 : bips séparés de pauses (test du raccourcissement des blancs)
    const wav = process.env.HARNESS_SPEECH ? fixtureSpeechWav() : fixtureWav(3);
    return args.body?.format === 'wav'
      ? { httpStatus: 200, contentType: 'audio/wav', audio: wav, ttfbMs: 600, totalMs: 1000 }
      : { httpStatus: 200, contentType: 'audio/mpeg', audio: fixtureMp3(120), ttfbMs: 600, totalMs: 1000 };
  }
});
Object.defineProperty(fish, 'configured', { get: () => Boolean(fish.apiKey) });
fish.voices.set('voix-publique-test', { id: 'voix-publique-test', type: 'tts', title: 'Voix publique (test)', state: 'trained', visibility: 'public', takenDown: false });
const app = createApp({ config, fishClient: fish });
await app.listen(Number(port));
const s = app.services;
const OWNER = { role: 'owner' };
if (!app.auth.ownerExists()) app.auth.setupOwner('harnais-motdepasse');
const token = app.auth.login('harnais-motdepasse', 'harness');
if (process.env.NO_PROJECT) {
  await s.importVoice(OWNER, { name: 'Voix V1 (test)', referenceId: 'voix-test-1', rightsConfirmed: true }).catch(() => {});
} else if (!s.listProjects().length) {
  const p = s.createProject(OWNER, { name: 'Introduction de tutoriel (démo)' });
  s.createSegment(OWNER, p.id, { title: 'Accroche', spokenText: 'Il reste une copie. On peut encore tout récupérer.', instruction: '[calm]' });
  s.createSegment(OWNER, p.id, { title: 'Le risque', spokenText: 'Un seul dossier, une seule copie : il suffit d’un disque qui lâche pour tout perdre.' });
  await s.importVoice(OWNER, { name: 'Voix test (harnais)', referenceId: 'voix-test-1', rightsConfirmed: true });
  s.createProposal({ role: 'agent' }, { projectId: p.id, title: 'Conclusion', spokenText: 'Faites une copie aujourd’hui, pas demain.', deliveryInstruction: '[excited]', note: 'Proposition de test du harnais' });
}
console.log(`COOKIE=${token}`);
