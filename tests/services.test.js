// T05, T07, T08, T09, T10, T15, T16 : quotas, droits de l'agent, invalidation, idempotence,
// redémarrage, clonage, regénération ciblée
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeApp, seed, generateOnce, testConfig, fakeFish, fixtureWav, fixtureMp3, OWNER, AGENT } from './helpers.js';
import { createApp } from '../src/app.js';
import { ProviderError } from '../src/fish.js';

test('parcours nominal : plan → approbation → génération → prise MP3 vérifiée', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  const job = await generateOnce(services, { segmentId: segment.id, voiceId: voice.id });
  assert.equal(job.state, 'succeeded');
  assert.equal(fish.calls.tts.length, 1);
  assert.equal(fish.calls.tts[0].providerModel, 's2.1-pro-free');
  assert.equal(fish.calls.tts[0].body.text, '[calm] Il reste une copie. On peut encore tout récupérer.');
  const take = services.getProject(segment.projectId).segments[0].takes[0];
  assert.equal(take.source, 'fish_audio');
  assert.equal(take.providerReportedModel, null);
  assert.ok(take.durationSec > 2 && take.durationSec < 3);
  assert.equal(take.chosen, true);
  assert.ok(job.timings.totalMs !== null);
});

test('T05 : le quota quotidien bloque, y compris avec plusieurs approbations simultanées', async () => {
  const { services } = makeApp({ config: testConfig({ MAX_GENERATIONS_PER_DAY: '2' }) });
  const { segment, voice } = await seed(services);
  const plans = [1, 2, 3].map(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id }));
  services.approvePlan(OWNER, plans[0].id);
  services.approvePlan(OWNER, plans[1].id);
  assert.throws(() => services.approvePlan(OWNER, plans[2].id), (e) => e.code === 'daily_quota');
});

test('T05 bis : un texte au-delà de 5 000 octets est refusé', async () => {
  const { services } = makeApp();
  const project = services.createProject(OWNER, { name: 'P' });
  assert.throws(() => services.createSegment(OWNER, project.id, { spokenText: 'é'.repeat(2600) }), (e) => e.code === 'too_long');
});

test('T07 : l’agent ne peut ni approuver, ni créer de clone, ni décider, même avec approved=true injecté', async () => {
  const { services } = makeApp();
  const { project, segment, voice } = await seed(services);
  const plan = services.createPlan(AGENT, { segmentId: segment.id, voiceId: voice.id, approved: true, state: 'approved' });
  assert.equal(plan.state, 'pending_approval');
  assert.throws(() => services.approvePlan(AGENT, plan.id), (e) => e.status === 403);
  assert.throws(() => services.executePlan(AGENT, { planId: plan.id, idempotencyKey: 'agent-cle-1234' }), (e) => e.code === 'not_approved');
  await assert.rejects(services.cloneVoice(AGENT, { title: 'x', consent: true, file: fixtureWav(15) }), (e) => e.status === 403);
  const prop = services.createProposal(AGENT, { projectId: project.id, spokenText: 'Texte agent', approved: true });
  assert.equal(prop.state, 'proposed');
  assert.throws(() => services.decideProposal(AGENT, prop.id, { decision: 'accept' }), (e) => e.status === 403);
  assert.throws(() => services.createProject(AGENT, { name: 'x' }), (e) => e.status === 403);
});

test('T08 : une modification du texte après approbation invalide le plan', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  const plan = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  services.approvePlan(OWNER, plan.id);
  services.createRevision(OWNER, segment.id, { baseRevisionId: segment.currentRevisionId, spokenText: 'Texte modifié.', instruction: '[calm]' });
  assert.throws(() => services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-modif-1234' }), (e) => e.code === 'stale_plan');
  assert.equal(fish.calls.tts.length, 0);
  // Révision de départ obsolète : conflit
  assert.throws(() => services.createRevision(OWNER, segment.id, { baseRevisionId: segment.currentRevisionId, spokenText: 'Autre' }), (e) => e.code === 'revision_conflict');
});

test('T09 : double clic, même clé ou deux clés sur la même approbation → un seul appel', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  const plan = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  services.approvePlan(OWNER, plan.id);
  const a = services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-unique-0001' });
  const b = services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-unique-0001' });
  assert.equal(a.job.id, b.job.id);
  assert.equal(b.reused, true);
  assert.throws(() => services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-unique-0002' }), (e) => e.code === 'approval_consumed');
  // Même clé, autre plan : 409
  const plan2 = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  services.approvePlan(OWNER, plan2.id);
  assert.throws(() => services.executePlan(OWNER, { planId: plan2.id, idempotencyKey: 'cle-unique-0001' }), (e) => e.code === 'idempotency_conflict');
  await services.worker.kick();
  assert.equal(fish.calls.tts.length, 1);
});

test('T10 : une tâche en cours au redémarrage devient incertaine et n’est pas rejouée', async () => {
  const config = testConfig();
  let release;
  const fish1 = fakeFish({ tts: () => new Promise((r) => { release = r; }) });
  const app1 = createApp({ config, fishClient: fish1 });
  const { segment, voice } = await seed(app1.services);
  const plan = app1.services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  app1.services.approvePlan(OWNER, plan.id);
  const { job } = app1.services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-redemarrage' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(app1.services.getGeneration(job.id).state, 'running');
  // « Redémarrage » : nouvelle instance sur le même dossier de données
  const fish2 = fakeFish();
  const app2 = createApp({ config, fishClient: fish2 });
  assert.equal(app2.services.recoverAfterRestart(), 1);
  const after = app2.services.getGeneration(job.id);
  assert.equal(after.state, 'uncertain');
  await app2.services.worker.kick();
  assert.equal(fish2.calls.tts.length, 0);
  release?.({ httpStatus: 200, audio: Buffer.alloc(0) });
});

test('T11 : un audio vide ou illisible ne crée pas de prise', async () => {
  for (const audio of [Buffer.alloc(0), Buffer.from('pas un mp3 du tout, juste du texte')]) {
    const { services } = makeApp({ fish: fakeFish({ tts: () => ({ httpStatus: 200, contentType: 'audio/mpeg', audio, ttfbMs: 1, totalMs: 2 }) }) });
    const { segment, voice } = await seed(services);
    const job = await generateOnce(services, { segmentId: segment.id, voiceId: voice.id });
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'invalid_audio');
    assert.equal(services.getProject(segment.projectId).segments[0].takes.length, 0);
  }
});

test('T12 : 429 → reprise bornée sur la même tâche ; 5xx → incertain sans répétition', async () => {
  const { services, fish } = makeApp({ fish: fakeFish({ tts: (args, n) => {
    if (n < 3) throw new ProviderError('rate_limited', 'Trop de requêtes.', { httpStatus: 429, retryAfterMs: 1 });
    return { httpStatus: 200, contentType: 'audio/wav', audio: fixtureWav(2.6), ttfbMs: 1, totalMs: 1 };
  } }) });
  const { segment, voice } = await seed(services);
  services.worker.backoffMs = () => 1;
  const job = await generateOnce(services, { segmentId: segment.id, voiceId: voice.id });
  assert.equal(job.attempts, 3);
  assert.equal(job.state, 'succeeded');
  assert.equal(fish.calls.tts.length, 3);

  const s2 = makeApp({ fish: fakeFish({ tts: () => { throw new ProviderError('uncertain', 'Erreur serveur Fish Audio 503.', { httpStatus: 503 }); } }) });
  const seeded = await seed(s2.services);
  const j2 = await generateOnce(s2.services, { segmentId: seeded.segment.id, voiceId: seeded.voice.id });
  assert.equal(j2.state, 'uncertain');
  assert.equal(s2.fish.calls.tts.length, 1);

  const s3 = makeApp({ fish: fakeFish({ tts: () => { throw new ProviderError('payment', 'Solde insuffisant.', { httpStatus: 402 }); } }) });
  const seeded3 = await seed(s3.services);
  const j3 = await generateOnce(s3.services, { segmentId: seeded3.segment.id, voiceId: seeded3.voice.id });
  assert.equal(j3.state, 'failed');
  assert.equal(s3.fish.calls.tts.length, 1);
});

test('T15 : clonage → consentement, fichier valide, private envoyé puis relu', async () => {
  const { services, fish } = makeApp();
  await assert.rejects(services.cloneVoice(OWNER, { title: 'Moi', consent: false, file: fixtureWav(15) }), (e) => e.code === 'consent_required');
  await assert.rejects(services.cloneVoice(OWNER, { title: 'Moi', consent: true, file: fixtureWav(5) }), (e) => e.code === 'invalid_file');
  await assert.rejects(services.cloneVoice(OWNER, { title: 'Moi', consent: true, file: fixtureWav(65) }), (e) => e.code === 'invalid_file');
  await assert.rejects(services.cloneVoice(OWNER, { title: 'Moi', consent: true, file: Buffer.from('MZ fichier exécutable') }), (e) => e.code === 'invalid_file');
  assert.equal(fish.calls.createVoice.length, 0);
  const v = await services.cloneVoice(OWNER, { title: 'Moi', consent: true, file: fixtureWav(15), transcript: 'Bonjour' });
  assert.equal(v.state, 'ready');
  assert.equal(v.visibility, 'private');
  assert.equal(fish.calls.createVoice[0].enhanceAudio, false);
  assert.ok(fish.calls.getVoice.includes(v.referenceId), 'relecture effectuée');

  // Visibilité relue différente : jamais déclarée prête
  const other = makeApp({ fish: fakeFish({ cloneVisibility: 'unlist' }) });
  const v2 = await other.services.cloneVoice(OWNER, { title: 'Moi', consent: true, file: fixtureWav(15) });
  assert.equal(v2.state, 'refused');
});

test('T16 : regénérer un segment conserve les prises et choix des autres', async () => {
  const { services } = makeApp();
  const { project, segment, voice } = await seed(services);
  const seg2 = services.createSegment(OWNER, project.id, { title: 'Deux', spokenText: 'Deuxième phrase.' });
  await generateOnce(services, { segmentId: segment.id, voiceId: voice.id });
  await generateOnce(services, { segmentId: seg2.id, voiceId: voice.id });
  const before = services.getProject(project.id).segments;
  await generateOnce(services, { segmentId: seg2.id, voiceId: voice.id, instruction: '[excited]' });
  const after = services.getProject(project.id).segments;
  assert.deepEqual(after[0].takes.map((t) => t.id), before[0].takes.map((t) => t.id));
  assert.equal(after[0].chosenTakeId, before[0].chosenTakeId);
  assert.equal(after[1].takes.length, 2);
  assert.equal(after[1].chosenTakeId, before[1].chosenTakeId, 'le choix existant n’est pas remplacé silencieusement');
});

test('proposition de l’agent : acceptation crée une révision « agent », conflit → obsolète', async () => {
  const { services } = makeApp();
  const { project, segment } = await seed(services);
  const p = services.createProposal(AGENT, { projectId: project.id, segmentId: segment.id, baseRevisionId: segment.currentRevisionId, spokenText: 'Version agent.', deliveryInstruction: '[excited]' });
  const accepted = services.decideProposal(OWNER, p.id, { decision: 'accept' });
  assert.equal(accepted.state, 'approved');
  const seg = services.getProject(project.id).segments[0];
  assert.equal(seg.revision.author, 'agent');
  assert.equal(seg.revision.finalText, '[excited] Version agent.');
  // Proposition fondée sur une révision dépassée
  const stale = services.createProposal(AGENT, { projectId: project.id, segmentId: segment.id, baseRevisionId: seg.currentRevisionId, spokenText: 'A' });
  services.createRevision(OWNER, segment.id, { baseRevisionId: seg.currentRevisionId, spokenText: 'Modifié par le propriétaire.' });
  assert.throws(() => services.decideProposal(OWNER, stale.id, { decision: 'accept' }), (e) => e.code === 'obsolete');
  assert.equal(services.getProposal(stale.id).state, 'obsolete');
});

test('voix du compte : listées, « déjà ajoutée » signalée, propriétaire uniquement', async () => {
  const { services, fish } = makeApp();
  fish.voices.set('voix-publique', { id: 'voix-publique', type: 'tts', title: 'Voix V1', state: 'trained', visibility: 'public', takenDown: false });
  fish.voices.set('voix-en-cours', { id: 'voix-en-cours', type: 'tts', title: 'En cours', state: 'training', visibility: 'private', takenDown: false });
  const before = await services.listAccountVoices(OWNER);
  assert.equal(before.items.length, 3);
  assert.equal(before.items.find((v) => v.id === 'voix-en-cours').usable, false);
  await services.importVoice(OWNER, { name: 'Voix V1', referenceId: 'voix-publique', rightsConfirmed: true });
  const after = await services.listAccountVoices(OWNER);
  assert.ok(after.items.find((v) => v.id === 'voix-publique').localVoiceId);
  await assert.rejects(services.listAccountVoices(AGENT), (e) => e.status === 403);
});

test('réglages audio : envoyés dans prosody, validés, conservés sur la prise', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  for (const audio of [{ normalizeLoudness: 'non' }, { volumeDb: -50 }, { volumeDb: 1.5 }, 'fort']) {
    assert.throws(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, audio }), (e) => e.code === 'invalid_audio_options', JSON.stringify(audio));
  }
  const plan = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, audio: { normalizeLoudness: false, volumeDb: -6 } });
  services.approvePlan(OWNER, plan.id);
  services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-reglages-audio' });
  await services.worker.kick();
  assert.deepEqual(fish.calls.tts[0].body.prosody, { normalize_loudness: false, volume: -6 });
  const take = services.getProject(segment.projectId).segments[0].takes[0];
  assert.deepEqual(take.audioOptions, { normalizeLoudness: false, volumeDb: -6, format: 'wav', sampleRate: 44100 });
  assert.match(take.audioUrl, /audio$/);
  // Sans réglage : valeurs par défaut de Fish Audio, explicites
  const p2 = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  assert.deepEqual(p2.request.body.prosody, { normalize_loudness: true, volume: -1 });
});

test('formats : MP3 192 kbit/s sur demande, 48 kHz refusé, réponse d’un autre format refusée', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  for (const audio of [{ format: 'flac' }, { sampleRate: 22050 }, { sampleRate: 48000 }]) {
    assert.throws(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, audio }), (e) => e.code === 'invalid_audio_options');
  }
  const job = await (async () => {
    const plan = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, audio: { format: 'mp3' } });
    services.approvePlan(OWNER, plan.id);
    const { job } = services.executePlan(OWNER, { planId: plan.id, idempotencyKey: 'cle-format-mp3' });
    await services.worker.kick();
    return services.getGeneration(job.id);
  })();
  assert.equal(job.state, 'succeeded');
  assert.equal(fish.calls.tts[0].body.mp3_bitrate, 192);
  assert.equal(fish.calls.tts[0].body.sample_rate, 44100);
  // WAV demandé mais MP3 reçu : pas de prise
  const bad = makeApp({ fish: fakeFish({ tts: () => ({ httpStatus: 200, contentType: 'audio/mpeg', audio: fixtureMp3(), ttfbMs: 1, totalMs: 1 }) }) });
  const sb = await seed(bad.services);
  const j2 = await generateOnce(bad.services, { segmentId: sb.segment.id, voiceId: sb.voice.id });
  assert.equal(j2.state, 'failed');
});

test('WAV reçu en flux sans taille : en-tête corrigé, durée mesurée', async () => {
  const { finalizeWav, analyzeAudio } = await import('../src/audio.js');
  const wav = fixtureWav(2);
  wav.writeUInt32LE(0xffffffff, 4);
  wav.writeUInt32LE(0xffffffff, 40);
  const fixed = finalizeWav(wav);
  assert.equal(fixed.readUInt32LE(40), wav.length - 44);
  assert.equal(analyzeAudio(fixed).durationSec, 2);
});

test('dialogue : mode, voix A/B et intervenant par segment, validés côté serveur', async () => {
  const { services } = makeApp();
  const { project, segment, voice } = await seed(services);
  assert.equal(services.getProject(project.id).mode, 'mono');
  assert.equal(segment.speaker, 'A');
  const p = services.setProjectCast(OWNER, project.id, { mode: 'dialogue', voices: { A: voice.id, B: voice.id }, names: { A: 'ALEX', B: 'SAM' } });
  assert.equal(p.mode, 'dialogue');
  assert.deepEqual(p.voices, { A: voice.id, B: voice.id });
  assert.deepEqual(p.names, { A: 'ALEX', B: 'SAM' });
  assert.throws(() => services.setProjectCast(OWNER, project.id, { mode: 'trio' }), (e) => e.code === 'invalid');
  assert.throws(() => services.setProjectCast(OWNER, project.id, { mode: 'dialogue', voices: { A: 'voi_inconnue' } }), (e) => e.status === 404);
  assert.equal(services.setSegmentSpeaker(OWNER, segment.id, 'B').segments[0].speaker, 'B');
  assert.throws(() => services.setSegmentSpeaker(OWNER, segment.id, 'C'), (e) => e.code === 'invalid');
  assert.equal(services.createSegment(OWNER, project.id, { spokenText: 'Réplique.', speaker: 'B' }).speaker, 'B');
  assert.throws(() => services.createSegment(OWNER, project.id, { spokenText: 'x', speaker: 'Z' }), (e) => e.code === 'invalid');
  assert.throws(() => services.setProjectCast(AGENT, project.id, { mode: 'mono' }), (e) => e.status === 403);
});

test('catalogue : voix inutilisables écartées, voix déjà ajoutée signalée, réservé au propriétaire', async () => {
  const fish = fakeFish({ searchVoices: () => ({ total: 3, items: [
    { id: 'voix-test-1', type: 'tts', title: 'Déjà là', state: 'trained', takenDown: false },
    { id: 'pub-2', type: 'tts', title: 'Libre', state: 'trained', takenDown: false },
    { id: 'pub-3', type: 'tts', title: 'Retirée', state: 'trained', takenDown: true }
  ] }) });
  const { services } = makeApp({ fish });
  const { voice } = await seed(services);
  const r = await services.searchCatalog(OWNER, { tags: ['female', 'calm'] });
  await assert.rejects(services.searchCatalog(OWNER, { tags: ['inconnu'] }), (e) => e.code === 'invalid');
  await assert.rejects(services.searchCatalog(OWNER, { page: 0 }), (e) => e.code === 'invalid');
  assert.deepEqual(r.items.map((v) => v.id), ['voix-test-1', 'pub-2']);
  assert.equal(r.items[0].localVoiceId, voice.id);
  assert.equal(fish.calls.search[0].licensedOnly, true);
  assert.deepEqual(fish.calls.search[0].tags, ['female', 'calm']);
  await assert.rejects(services.searchCatalog(AGENT, {}), (e) => e.status === 403);
});


test('montage : réglages enregistrés par projet, bornes vérifiées, décalages limités au projet', async () => {
  const { services } = makeApp();
  const { project, segment } = await seed(services);
  assert.equal(services.getProject(project.id).montage, null);
  const p = services.setProjectMontage(OWNER, project.id, {
    gap: 0.5,
    mix: { A: { volume: -2, low: 3, mid: 0, high: -1, comp: true, room: 0.2, mute: false, solo: false } },
    nudges: { [segment.id]: -0.3, seg_autreprojet: 1, [`${segment.id}x`]: 0 }
  });
  assert.equal(p.montage.gap, 0.5);
  assert.equal(p.montage.mix.A.comp, true);
  assert.deepEqual(p.montage.mix.B, { volume: 0, low: 0, mid: 0, high: 0, comp: false, room: 0, mute: false, solo: false });
  assert.deepEqual(p.montage.nudges, { [segment.id]: -0.3 });
  for (const bad of [{ gap: 5 }, { mix: { A: { volume: 40 } } }, { mix: { B: { room: 2 } } }, { mix: { A: { comp: 'oui' } } }, { nudges: { '../x': 1 } }, { nudges: { seg_a: 500 } }]) {
    assert.throws(() => services.setProjectMontage(OWNER, project.id, bad), (e) => e.code === 'invalid', JSON.stringify(bad));
  }
  assert.throws(() => services.setProjectMontage(AGENT, project.id, { gap: 0 }), (e) => e.status === 403);
});

test('montage : coupes par segment et réglages de la musique validés', async () => {
  const { services } = makeApp();
  const { project, segment } = await seed(services);
  const p = services.setProjectMontage(OWNER, project.id, {
    maxPause: 0.4,
    edits: { [segment.id]: { in: 0.12, out: 0.3, cuts: [[1.2, 1.9]] }, seg_autreprojet: { in: 1 }, seg_vide: { in: 0, out: 0, cuts: [] } },
    music: { volume: -20, duck: 12, loop: false }
  });
  assert.equal(p.montage.maxPause, 0.4);
  assert.deepEqual(p.montage.edits, { [segment.id]: { in: 0.12, out: 0.3, cuts: [[1.2, 1.9]] } });
  assert.equal(p.montage.music.volume, -20);
  assert.equal(p.montage.music.loop, false);
  assert.equal(p.montage.music.fadeIn, 2);
  for (const bad of [{ maxPause: 5 }, { edits: { [segment.id]: { cuts: [[2, 1]] } } }, { edits: { [segment.id]: { in: -1 } } }, { music: { duck: 99 } }, { music: { loop: 'oui' } }]) {
    assert.throws(() => services.setProjectMontage(OWNER, project.id, bad), (e) => e.code === 'invalid', JSON.stringify(bad));
  }
});

test('musique de fond : format vérifié, remplacement, retrait, réservée au propriétaire', async () => {
  const { services, config } = makeApp();
  const { project } = await seed(services);
  const wav = fixtureWav(1);
  assert.throws(() => services.setProjectMusic(OWNER, project.id, { buffer: Buffer.alloc(4000), name: 'faux.mp3' }), (e) => e.code === 'invalid_audio');
  assert.throws(() => services.setProjectMusic(AGENT, project.id, { buffer: wav, name: 'x.wav' }), (e) => e.status === 403);
  const p = services.setProjectMusic(OWNER, project.id, { buffer: wav, name: 'Générique.wav' });
  assert.deepEqual({ name: p.music.name, format: p.music.format, size: p.music.size }, { name: 'Générique.wav', format: 'wav', size: wav.length });
  assert.equal(services.getProjectMusic(project.id).mime, 'audio/wav');
  const countMusic = () => fs.readdirSync(config.audioDir).filter((f) => f.startsWith('music_')).length;
  services.setProjectMusic(OWNER, project.id, { buffer: fixtureMp3(20), name: 'autre.mp3' });
  assert.equal(countMusic(), 1, 'l’ancienne musique est remplacée');
  assert.equal(services.getProjectMusic(project.id).mime, 'audio/mpeg');
  assert.equal(services.removeProjectMusic(OWNER, project.id).music, null);
  assert.equal(countMusic(), 0);
  assert.throws(() => services.getProjectMusic(project.id), (e) => e.status === 404);
});

test('écoute des voix autorisées : extrait Fish relevé à la vérification, sinon dernière prise faite avec la voix', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  assert.equal(services.listVoices(OWNER)[0].sampleUrl, null);
  assert.equal(services.listVoices(OWNER)[0].lastTakeUrl, null);
  await generateOnce(services, { segmentId: segment.id, voiceId: voice.id });
  const take = services.getProject(segment.projectId).segments[0].takes[0];
  assert.equal(services.listVoices(OWNER)[0].lastTakeUrl, `/api/v1/takes/${take.id}/audio`);
  // Extrait apparu chez Fish : repris à la revérification
  const ref = services.listVoices(OWNER)[0].referenceId;
  fish.voices.set(ref, { ...fish.voices.get(ref), sampleUrl: 'https://platform.r2.fish.audio/task/x.mp3' });
  await services.refreshVoice(OWNER, voice.id);
  assert.equal(services.listVoices(OWNER)[0].sampleUrl, 'https://platform.r2.fish.audio/task/x.mp3');
});

test('propositions de l’agent : intervenant A/B choisi pour un nouveau segment ou une révision, voix de l’intervenant indiquée', async () => {
  const { services } = makeApp();
  const { project, segment, voice } = await seed(services);
  services.setProjectCast(OWNER, project.id, { mode: 'dialogue', voices: { A: voice.id, B: voice.id }, names: { A: 'ALEX', B: 'SAM' } });
  assert.throws(() => services.createProposal(AGENT, { projectId: project.id, spokenText: 'x', speaker: 'C' }), (e) => e.code === 'invalid');
  // Nouveau segment sur B
  const p = services.createProposal(AGENT, { projectId: project.id, spokenText: 'Salut Alex.', speaker: 'B' });
  assert.equal(p.speaker, 'B');
  assert.equal(p.speakerName, 'SAM');
  assert.equal(p.castVoiceId, voice.id);
  const accepted = services.decideProposal(OWNER, p.id, { decision: 'accept' });
  const created = services.getProject(project.id).segments.find((s) => s.id === accepted.resultSegmentId);
  assert.equal(created.speaker, 'B');
  // Révision qui fait passer un segment de A à B ; sans speaker, l'intervenant reste inchangé
  const r = services.createProposal(AGENT, { projectId: project.id, segmentId: segment.id, baseRevisionId: segment.currentRevisionId, spokenText: 'Version B.', speaker: 'B' });
  services.decideProposal(OWNER, r.id, { decision: 'accept' });
  const seg = services.getProject(project.id).segments.find((s) => s.id === segment.id);
  assert.equal(seg.speaker, 'B');
  const r2 = services.createProposal(AGENT, { projectId: project.id, segmentId: segment.id, baseRevisionId: seg.currentRevisionId, spokenText: 'Encore.' });
  assert.equal(r2.speaker, 'B');
  services.decideProposal(OWNER, r2.id, { decision: 'accept' });
  assert.equal(services.getProject(project.id).segments.find((s) => s.id === segment.id).speaker, 'B');
  // Sans speaker, un nouveau segment va sur A
  const p3 = services.createProposal(AGENT, { projectId: project.id, spokenText: 'Par défaut.' });
  const a3 = services.decideProposal(OWNER, p3.id, { decision: 'accept' });
  assert.equal(services.getProject(project.id).segments.find((s) => s.id === a3.resultSegmentId).speaker, 'A');
});

test('mode autonome : désactivé par défaut, puis création et génération par l’agent, modèle gratuit et plafond propre', async () => {
  const { services } = makeApp();
  const { voice } = await seed(services);
  // Désactivé : l'agent ne peut que proposer
  assert.throws(() => services.createProject(AGENT, { name: 'heygen-01' }), (e) => e.code === 'autonomy_off');
  // Réglage réservé au propriétaire, plafond borné
  assert.throws(() => services.setAgentAutonomy(AGENT, { enabled: true }), (e) => e.status === 403);
  assert.throws(() => services.setAgentAutonomy(OWNER, { enabled: true, dailyLimit: 0 }), (e) => e.code === 'invalid');
  assert.deepEqual(services.setAgentAutonomy(OWNER, { enabled: true, dailyLimit: 1 }), { enabled: true, dailyLimit: 1, generationsToday: 0 });
  // Projet, dialogue, segments : l'agent fait tout seul
  const project = services.createProject(AGENT, { name: 'heygen-01' });
  assert.equal(project.createdBy, 'agent');
  services.setProjectCast(AGENT, project.id, { mode: 'dialogue', voices: { A: voice.id, B: voice.id }, names: { A: 'Alex', B: 'Sam' } });
  const s1 = services.createSegment(AGENT, project.id, { spokenText: 'Bonjour Sam !', instruction: '[happy]', speaker: 'A' });
  const s2 = services.createSegment(AGENT, project.id, { spokenText: 'Salut Alex.', speaker: 'B' });
  assert.equal(s1.revision.author, 'agent');
  const r1 = services.createRevision(AGENT, s1.id, { baseRevisionId: s1.currentRevisionId, spokenText: 'Bonjour Sam ! [laughing]' });
  assert.equal(r1.revision.author, 'agent');
  // Génération sur le modèle gratuit, prise choisie par l'agent
  const plan = services.createPlan(AGENT, { segmentId: s1.id, voiceId: voice.id, modelKey: 's21_free' });
  services.approvePlan(AGENT, plan.id);
  const { job } = services.executePlan(AGENT, { planId: plan.id, idempotencyKey: 'agent-cle-1' });
  await services.worker.kick();
  const take = services.getGeneration(job.id).takeId;
  assert.ok(take);
  services.chooseTake(AGENT, s1.id, take);
  assert.equal(services.capabilities().agentAutonomy.generationsToday, 1);
  // Plafond de l'agent atteint ; le propriétaire, lui, peut encore générer
  const plan2 = services.createPlan(AGENT, { segmentId: s2.id, voiceId: voice.id, modelKey: 's21_free' });
  assert.throws(() => services.approvePlan(AGENT, plan2.id), (e) => e.code === 'agent_quota');
  services.approvePlan(OWNER, plan2.id);
  // Modèle payant refusé à l'agent, même quand le propriétaire l'a autorisé pour lui-même
  const paidApp = makeApp({ config: testConfig({ ALLOW_PAID_GENERATION: 'true', PAID_BUDGET_TOTAL_USD: '5', PAID_MAX_PER_REQUEST_USD: '1' }) });
  const ps = await seed(paidApp.services);
  paidApp.services.setAgentAutonomy(OWNER, { enabled: true });
  const paid = paidApp.services.createPlan(AGENT, { segmentId: ps.segment.id, voiceId: ps.voice.id, modelKey: 's21_paid' });
  assert.throws(() => paidApp.services.approvePlan(AGENT, paid.id), (e) => e.code === 'agent_paid');
  paidApp.services.approvePlan(OWNER, paid.id);
  // Voix et réglages restent au propriétaire, même en mode autonome
  await assert.rejects(services.importVoice(AGENT, { name: 'x', referenceId: 'voix-test-1', rightsConfirmed: true }), (e) => e.status === 403);
  assert.throws(() => services.archiveSegment(AGENT, s2.id), (e) => e.status === 403);
  // Coupé : retour immédiat au mode proposition
  services.setAgentAutonomy(OWNER, { enabled: false });
  assert.throws(() => services.createSegment(AGENT, project.id, { spokenText: 'x' }), (e) => e.code === 'autonomy_off');
});

test('réglages : clé Fish vérifiée et jamais renvoyée, plafonds payants, retour au .env, persistance', async () => {
  const fish = fakeFish({
    listOwnVoices: (key) => {
      if (key === 'cle-refusee-0123456789') throw new ProviderError('auth', 'Clé refusée.', { httpStatus: 401 });
      return { total: 0, items: [] };
    }
  });
  const config = testConfig();
  const { services } = makeApp({ config, fish });
  // Réservé au propriétaire
  await assert.rejects(services.updateSettings(AGENT, { allowPaid: false }), (e) => e.status === 403);
  // Clé refusée : l'ancienne reste en place
  await assert.rejects(services.updateSettings(OWNER, { fishApiKey: 'cle-refusee-0123456789' }), (e) => e.code === 'fish_key_refused');
  assert.equal(fish.apiKey, config.base.fishApiKey);
  assert.equal(services.settingsView().fishKey.source, 'env');
  // Clé acceptée : appliquée à chaud, jamais présente dans la vue
  const r = await services.updateSettings(OWNER, { fishApiKey: '  cle-acceptee-0123456789  ' });
  assert.equal(fish.apiKey, 'cle-acceptee-0123456789');
  assert.equal(r.settings.fishKey.source, 'settings');
  assert.ok(!JSON.stringify(r).includes('cle-acceptee'));
  // Payant : budgets obligatoires et cohérents
  await assert.rejects(services.updateSettings(OWNER, { allowPaid: true }), (e) => e.status === 400);
  await assert.rejects(services.updateSettings(OWNER, { allowPaid: true, paidBudgetTotalUsd: 1, paidMaxPerRequestUsd: 2 }), (e) => e.status === 400);
  await services.updateSettings(OWNER, { allowPaid: true, paidBudgetTotalUsd: 5, paidMaxPerRequestUsd: 1, freeOfferEndDate: '2027-01-31' });
  const paid = services.capabilities().models.find((m) => m.key === 's21_paid');
  assert.equal(paid.allowed, true);
  assert.equal(services.capabilities().freeOffer.endDate, '2027-01-31');
  await assert.rejects(services.updateSettings(OWNER, { maxGenerationsPerDay: 0 }), (e) => e.status === 400);
  await assert.rejects(services.updateSettings(OWNER, { inconnu: 1 }), (e) => e.status === 400);
  // Persistance : une nouvelle instance sur le même dossier reprend les réglages
  const again = makeApp({ config: testConfig({ DATA_DIR: config.dataDir }), fish: fakeFish() });
  assert.equal(again.services.settingsView().allowPaid, true);
  assert.equal(again.fish.apiKey, 'cle-acceptee-0123456789');
  // null : retour à la valeur du .env
  await services.updateSettings(OWNER, { fishApiKey: null, allowPaid: null });
  assert.equal(fish.apiKey, config.base.fishApiKey);
  assert.equal(services.settingsView().allowPaid, false);
});
