// T06 (adaptateur), T11, T12 : clé jamais exposée, réponses non audio refusées, politique d'erreurs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFishClient, ProviderError } from '../src/fish.js';
import { registerSecret } from '../src/redact.js';
import { fixtureMp3, SENTINEL_KEY } from './helpers.js';

registerSecret(SENTINEL_KEY);

const audioResponse = (buf, type = 'audio/mpeg') => new Response(buf, { status: 200, headers: { 'content-type': type } });
const jsonResponse = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl) {
  return createFishClient({ apiKey: SENTINEL_KEY, fetchImpl, timeoutMs: 2000 });
}

test('requête TTS : URL fixe, en-tête model explicite, redirection refusée', async () => {
  let seen;
  const c = client(async (url, init) => { seen = { url, init }; return audioResponse(fixtureMp3()); });
  const r = await c.tts({ providerModel: 's2.1-pro-free', body: { text: 'Bonjour', reference_id: 'x' } });
  assert.equal(seen.url, 'https://api.fish.audio/v1/tts');
  assert.equal(seen.init.headers.model, 's2.1-pro-free');
  assert.equal(seen.init.headers.Authorization, `Bearer ${SENTINEL_KEY}`);
  assert.equal(seen.init.redirect, 'manual');
  assert.ok(r.audio.length > 0);
  assert.ok(r.ttfbMs !== null);

  const redirecting = client(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  await assert.rejects(redirecting.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => e.code === 'redirect');
});

test('T11 : une réponse JSON 200 ne devient pas un audio', async () => {
  const c = client(async () => jsonResponse(200, { message: 'oops' }));
  await assert.rejects(c.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => e.code === 'invalid_audio');
});

test('T12 : 401, 402, 429, 5xx et délai dépassé suivent la politique prévue', async () => {
  const cases = [
    [401, 'auth'], [403, 'auth'], [402, 'payment'], [429, 'rate_limited'], [503, 'uncertain'], [500, 'uncertain'], [400, 'bad_request']
  ];
  for (const [status, code] of cases) {
    const c = client(async () => jsonResponse(status, { status, message: `erreur ${SENTINEL_KEY}` }, status === 429 ? { 'retry-after': '1' } : {}));
    await assert.rejects(c.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => {
      assert.equal(e.code, code, `HTTP ${status}`);
      assert.ok(!e.message.includes(SENTINEL_KEY), 'clé expurgée du message');
      if (status === 429) assert.equal(e.retryAfterMs, 1000);
      return true;
    });
  }
  // Délai dépassé après envoi : résultat incertain
  // Le minuteur garde la boucle active, comme le ferait une vraie connexion réseau
  const slow = createFishClient({ apiKey: SENTINEL_KEY, timeoutMs: 50, fetchImpl: (url, init) => new Promise((_, reject) => {
    const keep = setTimeout(() => {}, 1000);
    init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
  }) });
  await assert.rejects(slow.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => e.code === 'uncertain');
  // Rupture réseau
  const broken = client(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(broken.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => e.code === 'uncertain');
});

test('clé absente : aucune requête réseau', async () => {
  let called = false;
  const c = createFishClient({ apiKey: '', fetchImpl: async () => { called = true; } });
  await assert.rejects(c.tts({ providerModel: 's2.1-pro-free', body: {} }), (e) => e instanceof ProviderError && e.code === 'auth');
  assert.equal(called, false);
});

test('création de voix : multipart, visibility=private, generate_sample=false', async () => {
  let form;
  const c = client(async (url, init) => { form = init.body; return jsonResponse(201, { _id: 'nouvelle-voix' }); });
  const r = await c.createVoice({ title: 'Ma voix', file: Buffer.from('RIFF'), fileName: 'echantillon.wav', mimeType: 'audio/wav', transcript: '', enhanceAudio: false });
  assert.equal(r.id, 'nouvelle-voix');
  assert.ok(form instanceof FormData);
  assert.equal(form.get('visibility'), 'private');
  assert.equal(form.get('type'), 'tts');
  assert.equal(form.get('train_mode'), 'fast');
  assert.equal(form.get('generate_sample'), 'false');
  assert.equal(form.get('enhance_audio_quality'), 'false');
  assert.equal(form.get('texts'), null);
  assert.ok(form.get('voices') instanceof Blob);
});

test('lecture de voix : identifiant validé, champs autorisés uniquement', async () => {
  const c = client(async () => jsonResponse(200, { _id: 'v1', type: 'tts', title: 'T', state: 'trained', visibility: 'private', author: { nickname: 'secret' }, samples: [{ audio: 'https://platform.r2.fish.audio/task/x.mp3' }] }));
  const v = await c.getVoice('v1');
  assert.deepEqual(Object.keys(v).sort(), ['id', 'sampleUrl', 'state', 'takenDown', 'title', 'type', 'visibility']);
  assert.equal(v.sampleUrl, 'https://platform.r2.fish.audio/task/x.mp3');
  // Extrait hébergé ailleurs que chez Fish Audio : ignoré
  const other = client(async () => jsonResponse(200, { _id: 'v1', type: 'tts', state: 'trained', samples: [{ audio: 'https://exemple.com/x.mp3' }] }));
  assert.equal((await other.getVoice('v1')).sampleUrl, null);
  await assert.rejects(c.getVoice('../model'), (e) => e.code === 'bad_request');
});

test('voix du compte : GET /model?self=true, champs autorisés uniquement', async () => {
  let seenUrl;
  const c = client(async (url) => { seenUrl = url; return jsonResponse(200, { total: 1, items: [{ _id: 'v1', type: 'tts', title: 'Voix V1', state: 'trained', visibility: 'public', author: { nickname: 'x' } }, { _id: '../bad', title: 'x' }] }); });
  const r = await c.listOwnVoices();
  assert.ok(seenUrl.startsWith('https://api.fish.audio/model?self=true'), seenUrl);
  assert.equal(r.items.length, 1);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['id', 'state', 'takenDown', 'title', 'type', 'visibility']);
});

test('limite de crédit (création de voix) : signalée comme crédit requis, pas comme clé refusée', async () => {
  const c = client(async () => jsonResponse(403, { status: 403, message: 'API model creation limit reached (0/0). Top up API credit to raise the limit.' }));
  await assert.rejects(c.createVoice({ title: 'x', file: Buffer.from('RIFF'), fileName: 'e.wav', mimeType: 'audio/wav', transcript: '', enhanceAudio: false }), (e) => {
    assert.equal(e.code, 'payment');
    assert.match(e.message, /crédit API requis/);
    return true;
  });
});

test('catalogue : voix françaises sous licence par défaut, échantillon uniquement depuis Fish Audio', async () => {
  const urls = [];
  const c = client(async (url) => {
    urls.push(url);
    return jsonResponse(200, { total: 2, items: [
      { _id: 'v1', type: 'tts', title: 'Narrateur', state: 'trained', visibility: 'public', licensed: true, task_count: 26, author: { nickname: 'kev', _id: 'secret' }, samples: [{ audio: 'https://platform.r2.fish.audio/task/a.mp3' }] },
      { _id: 'v2', type: 'tts', title: 'Autre', state: 'trained', visibility: 'public', licensed: false, samples: [{ audio: 'https://evil.example/a.mp3' }] }
    ] });
  });
  const r = await c.searchVoices({ tags: ['male', 'calm'] });
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('language'), 'fr');
  assert.equal(u.searchParams.get('licensed'), 'true');
  assert.deepEqual(u.searchParams.getAll('tag'), ['male', 'calm']);
  assert.equal(r.items[0].sampleUrl, 'https://platform.r2.fish.audio/task/a.mp3');
  assert.equal(r.items[0].author, 'kev');
  assert.equal(r.items[1].sampleUrl, null);
  await c.searchVoices({ licensedOnly: false });
  assert.equal(new URL(urls[1]).searchParams.get('licensed'), null);
});
