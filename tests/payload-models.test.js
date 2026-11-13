// T01, T02, T03, T04, T13, T14 : modèle exact, refus des clés inconnues, Drama 3, UTF-8, payant, expiration
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalText, utf8Bytes, buildTtsBody, redactedRequest, estimateUsd, normalizeInstruction } from '../shared/payload.js';
import { modelAvailability, getModel, DEFAULT_MODEL_KEY } from '../src/models.js';
import { makeApp, seed, testConfig, OWNER } from './helpers.js';

test('T01 : modèle par défaut s21_free → en-tête model exactement s2.1-pro-free', async () => {
  assert.equal(DEFAULT_MODEL_KEY, 's21_free');
  const { services } = makeApp();
  const { segment, voice } = await seed(services);
  const plan = services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id });
  assert.equal(plan.modelKey, 's21_free');
  assert.equal(plan.request.headers.model, 's2.1-pro-free');
  assert.equal(plan.modelRequested, 's2.1-pro-free');
});

test('T02 : clé de modèle inconnue ou identifiant fournisseur libre refusés avant tout appel', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  for (const modelKey of ['s2.1-pro', 'drama-3', 'gpt', '__proto__', 'constructor']) {
    assert.throws(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, modelKey }), (e) => e.code === 'unknown_model', modelKey);
  }
  assert.equal(fish.calls.tts.length, 0);
});

test('T03 : Drama 3 bloqué (désactivé, payant) sans aucun repli', async () => {
  const { services, fish } = makeApp();
  const { segment, voice } = await seed(services);
  assert.throws(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id, modelKey: 'drama3' }), (e) => e.code === 'model_blocked');
  // Même activé, il reste payant : bloqué sans autorisation de dépense
  const cfg = testConfig({ ENABLE_DRAMA3: 'true' });
  assert.equal(modelAvailability('drama3', cfg).allowed, false);
  assert.equal(getModel('drama3').providerId, 'drama-3');
  assert.equal(fish.calls.tts.length, 0);
});

test('T04 : comptage UTF-8 identique aperçu/serveur, accents et emojis, texte final avec balise', () => {
  const text = 'Récupérez vos fichiers 🎧 dès aujourd’hui — ça évite des ennuis.';
  const final = buildFinalText(text, '[calm]');
  assert.equal(final, `[calm] ${text}`);
  assert.equal(utf8Bytes(final), Buffer.byteLength(final, 'utf8'));
  const body = buildTtsBody(final, 'ref');
  assert.equal(body.text, final);
  assert.deepEqual(Object.keys(body).sort(), ['format', 'latency', 'prosody', 'reference_id', 'sample_rate', 'text']);
  assert.equal(body.format, 'wav');
  assert.equal(body.sample_rate, 44100);
  assert.deepEqual(body.prosody, { normalize_loudness: true, volume: -1 });
  assert.equal(redactedRequest('s2.1-pro-free', body).body.text, final);
});

test('T13 : génération payante bloquée par défaut, prix absent jamais traité comme zéro', async () => {
  const cfg = testConfig();
  assert.equal(modelAvailability('s21_paid', cfg).allowed, false);
  assert.equal(estimateUsd(1000, undefined), null);
  assert.equal(estimateUsd(1000, null), null);
  assert.equal(estimateUsd(1_000_000, 15), 15);
  // Autorisé sans plafonds : toujours bloqué
  assert.equal(modelAvailability('s21_paid', testConfig({ ALLOW_PAID_GENERATION: 'true' })).allowed, false);
  assert.equal(modelAvailability('s21_paid', testConfig({ ALLOW_PAID_GENERATION: 'true', PAID_BUDGET_TOTAL_USD: '1', PAID_MAX_PER_REQUEST_USD: '0.1' })).allowed, true);
});

test('T14 : expiration de l’offre → mode free bloqué, prises existantes intactes', async () => {
  const cfg = testConfig({ FREE_OFFER_END_DATE: '2026-11-30' });
  assert.equal(modelAvailability('s21_free', cfg, new Date('2026-11-30T21:00:00Z')).allowed, true); // 22 h à Paris
  assert.equal(modelAvailability('s21_free', cfg, new Date('2026-11-30T23:30:00Z')).allowed, false); // 0 h 30 le 1er déc. à Paris
  const { services } = makeApp({ config: testConfig({ FREE_OFFER_END_DATE: '2020-01-01' }) });
  const { segment, voice } = await seed(services);
  assert.throws(() => services.createPlan(OWNER, { segmentId: segment.id, voiceId: voice.id }), (e) => e.code === 'model_blocked');
  assert.equal(services.capabilities().freeOffer.active, false);
  assert.ok(Array.isArray(services.getProject(segment.projectId).segments[0].takes));
});


test('indication de ton : toujours une seule balise entre crochets, jamais de texte lu hors crochets', () => {
  assert.equal(normalizeInstruction(''), '');
  assert.equal(normalizeInstruction('  '), '');
  assert.equal(normalizeInstruction('[calm]'), '[calm]');
  assert.equal(normalizeInstruction('tired but amused'), '[tired but amused]');
  assert.equal(normalizeInstruction("[whispering] c'est cool"), "[whispering c'est cool]");
  assert.equal(normalizeInstruction('[ ]'), '');
});
