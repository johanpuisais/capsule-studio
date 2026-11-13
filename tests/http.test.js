// T06, T07, T17 au niveau HTTP réel : authentification, CSRF, droits de l'agent,
// clé sentinelle absente de toutes les réponses, fichiers servis et journaux ; export ZIP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createApp } from '../src/app.js';
import { APP_ROOT } from '../src/config.js';
import { testConfig, fakeFish, fixtureWav, SENTINEL_KEY } from './helpers.js';

async function startServer() {
  const fish = fakeFish();
  const app = createApp({ config: testConfig(), fishClient: fish });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const bodies = [];
  let cookie = '';
  // Client HTTP qui conserve chaque corps de réponse pour l'audit de fuite
  const call = async (method, url, { body, headers = {}, raw = false, agent = null } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(agent ? { Authorization: `Bearer ${agent}` } : cookie ? { Cookie: cookie, 'X-Capsule-CSRF': '1' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && !agent) cookie = setCookie.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    bodies.push(buf.toString('latin1'));
    return { status: res.status, headers: res.headers, buf, json: raw ? null : (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() };
  };
  return { app, fish, base, call, bodies, clearCookie: () => { cookie = ''; } };
}

test('HTTP : parcours complet propriétaire + agent, sans fuite de la clé sentinelle', async (t) => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  t.after(() => { console.log = origLog; });

  const { app, call, bodies, base, clearCookie } = await startServer();
  t.after(() => app.close());

  // Non authentifié
  assert.equal((await call('GET', '/api/v1/projects')).status, 401);
  assert.equal((await call('GET', '/')).status, 302);

  // Création du propriétaire (anti-CSRF exigé)
  assert.equal((await call('POST', '/api/v1/session/setup', { body: { password: 'motdepasse-solide' } })).status, 403);
  assert.equal((await call('POST', '/api/v1/session/setup', { body: { password: 'motdepasse-solide' }, headers: { 'X-Capsule-CSRF': '1' } })).status, 200);
  assert.equal((await call('POST', '/api/v1/session/setup', { body: { password: 'autre-motdepasse' }, headers: { 'X-Capsule-CSRF': '1' } })).status, 409);

  // Origine étrangère refusée pour une mutation
  assert.equal((await call('POST', '/api/v1/projects', { body: { name: 'X' }, headers: { Origin: 'http://evil.example' } })).status, 403);

  const demo = (await call('POST', '/api/v1/demo')).json;
  const seg = demo.segments[0];
  const voice = (await call('POST', '/api/v1/voices/import', { body: { name: 'Voix test', referenceId: 'voix-test-1', rightsConfirmed: true } })).json;
  assert.equal(voice.state, 'ready');

  // Jeton agent
  const { token } = (await call('POST', '/api/v1/settings/agent-token')).json;
  assert.match(token, /^cs_agent_/);

  // Agent : routes propriétaire refusées
  for (const [m, u] of [['POST', '/api/v1/projects'], ['POST', `/api/v1/segments/${seg.id}/revisions`], ['POST', '/api/v1/voices/clone'], ['POST', '/api/v1/settings/agent-token'], ['GET', '/api/v1/settings'], ['POST', '/api/v1/demo']]) {
    assert.equal((await call(m, u, { body: m === 'GET' ? undefined : {}, agent: token })).status, 403, `${m} ${u}`);
  }
  assert.equal((await call('GET', '/api/v1/projects', { agent: 'cs_agent_faux' })).status, 401);
  // Les voix vues par l'agent ne contiennent pas la référence fournisseur
  const agentVoices = (await call('GET', '/api/v1/voices', { agent: token })).json.items;
  assert.equal(agentVoices[0].referenceId, undefined);

  // Agent : proposition puis tentative d'auto-approbation
  const prop = (await call('POST', '/api/v1/proposals', { agent: token, body: { projectId: demo.id, segmentId: seg.id, baseRevisionId: seg.currentRevisionId, spokenText: 'Version de l’agent.', deliveryInstruction: '[excited]', voiceId: voice.id } })).json;
  assert.equal(prop.state, 'proposed');
  assert.equal((await call('POST', `/api/v1/proposals/${prop.id}/decision`, { agent: token, body: { decision: 'accept' } })).status, 403);

  // Propriétaire : acceptation, plan, approbation
  const decided = (await call('POST', `/api/v1/proposals/${prop.id}/decision`, { body: { decision: 'accept' } })).json;
  const plan = (await call('POST', '/api/v1/generation-plans', { agent: token, body: { segmentId: seg.id, revisionId: decided.resultRevisionId, voiceId: voice.id, modelKey: 's21_free', proposalId: prop.id } })).json;
  assert.equal(plan.state, 'pending_approval');
  assert.equal(plan.request.headers.Authorization.includes(SENTINEL_KEY), false);
  assert.equal((await call('POST', '/api/v1/generations', { agent: token, body: { planId: plan.id }, headers: { 'Idempotency-Key': 'agent-tentative-01' } })).status, 403);
  assert.equal((await call('POST', `/api/v1/generation-plans/${plan.id}/approve`, { agent: token })).status, 403);
  assert.equal((await call('POST', `/api/v1/generation-plans/${plan.id}/approve`)).status, 200);

  // L'agent exécute le plan approuvé, avec idempotence
  const g1 = await call('POST', '/api/v1/generations', { agent: token, body: { planId: plan.id }, headers: { 'Idempotency-Key': 'agent-execution-01' } });
  assert.equal(g1.status, 202);
  const g2 = await call('POST', '/api/v1/generations', { agent: token, body: { planId: plan.id }, headers: { 'Idempotency-Key': 'agent-execution-01' } });
  assert.equal(g2.status, 200);
  assert.equal(g2.json.id, g1.json.id);
  await app.services.worker.kick();
  const done = (await call('GET', `/api/v1/generations/${g1.json.id}`, { agent: token })).json;
  assert.equal(done.state, 'succeeded');
  assert.ok(done.audioUrl);

  // Audio : accès contrôlé (agent oui, anonyme non), plage d'octets
  const audio = await call('GET', done.audioUrl, { agent: token, raw: true });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  const ranged = await call('GET', done.audioUrl, { agent: token, raw: true, headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.buf.length, 100);
  clearCookie();
  assert.equal((await call('GET', done.audioUrl, { raw: true })).status, 401);

  // T17 : export ZIP contrôlé, identifiants malveillants refusés
  const zip = await call('POST', '/api/v1/exports', { agent: token, body: { takeIds: [done.takeId] }, raw: true });
  assert.equal(zip.status, 200);
  assert.equal(zip.buf.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.buf.includes(Buffer.from('manifeste.json')));
  // Fichier nommé d'après le segment (monologue), sans identifiant technique
  assert.ok(!zip.buf.includes(Buffer.from('01-take_')));
  assert.match(zip.buf.toString('latin1'), /01-[A-Za-z0-9-]+\.(wav|mp3)/);
  for (const evil of ['../db', '..\\..\\db.json', 'take_x/../../db', '']) {
    assert.equal((await call('POST', '/api/v1/exports', { agent: token, body: { takeIds: [evil] } })).status, evil === '' || evil.includes('/') || evil.includes('\\') || evil.includes('.') ? 400 : 404, evil);
  }
  assert.equal((await call('POST', '/api/v1/exports', { body: { takeIds: [done.takeId] } })).status, 401);

  // Fichiers statiques : traversée refusée, données jamais servies
  for (const p of ['/../data/db.json', '/%2e%2e/src/config.js', '/shared/../src/fish.js', '/data/db.json']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
  }

  // T06 : la clé sentinelle n'apparaît dans aucune réponse, aucun fichier client, aucun journal
  for (const b of bodies) assert.equal(b.includes(SENTINEL_KEY), false, 'réponse HTTP');
  for (const dir of ['public', 'shared']) {
    for (const f of fs.readdirSync(path.join(APP_ROOT, dir))) {
      assert.equal(fs.readFileSync(path.join(APP_ROOT, dir, f), 'utf8').includes(SENTINEL_KEY), false, f);
    }
  }
  for (const l of logs) assert.equal(l.includes(SENTINEL_KEY), false, 'journal');
  assert.equal(fs.readFileSync(app.store.file, 'utf8').includes(SENTINEL_KEY), false, 'base locale');
});

test('HTTP : hôte étranger refusé (anti-rebinding DNS) et texte non UTF-8 refusé', async (t) => {
  const { app, call } = await startServer();
  t.after(() => app.close());
  // fetch interdit de modifier Host : requête HTTP brute
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/api/v1/session', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 421);
  await call('POST', '/api/v1/session/setup', { body: { password: 'motdepasse-solide' }, headers: { 'X-Capsule-CSRF': '1' } });
  const { token } = (await call('POST', '/api/v1/settings/agent-token')).json;
  const project = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  // « aujourd’hui » encodé en Windows-1252 (0x92) : refusé, pas corrompu
  const latin = Buffer.concat([Buffer.from(`{"projectId":"${project.id}","spokenText":"aujourd`), Buffer.from([0x92]), Buffer.from('hui"}')]);
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/proposals`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: latin });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'invalid_encoding');
});

test('HTTP : musique de fond envoyée brute, nom accentué conservé, CSRF et agent refusés', async (t) => {
  const { app, base, call } = await startServer();
  t.after(() => app.close());
  await call('POST', '/api/v1/session/setup', { body: { password: 'motdepasse-solide' }, headers: { 'X-Capsule-CSRF': '1' } });
  const project = (await call('POST', '/api/v1/projects', { body: { name: 'Podcast' } })).json;
  const cookie = (await call('POST', '/api/v1/session/login', { body: { password: 'motdepasse-solide' }, headers: { 'X-Capsule-CSRF': '1' } })).headers.get('set-cookie').split(';')[0];
  const wav = fixtureWav(1);
  const send = (headers) => fetch(`${base}/api/v1/projects/${project.id}/music`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, body: wav });
  assert.equal((await send({ Cookie: cookie })).status, 403, 'sans en-tête anti-CSRF');
  const res = await send({ Cookie: cookie, 'X-Capsule-CSRF': '1', 'X-Filename': encodeURIComponent('Générique été.wav') });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).music.name, 'Générique été.wav');
  const got = await fetch(`${base}/api/v1/projects/${project.id}/music`, { headers: { Cookie: cookie } });
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await got.arrayBuffer()).length, wav.length);
  const { token } = (await call('POST', '/api/v1/settings/agent-token')).json;
  assert.equal((await call('GET', `/api/v1/projects/${project.id}/music`, { agent: token })).status, 403);
  assert.equal((await call('POST', `/api/v1/projects/${project.id}/music/remove`)).json.music, null);
});

test('HTTP : accès réseau local en HTTPS (LAN=true), hôte vérifié, cookie Secure, certificat public servi', { skip: process.platform !== 'win32' && 'certificat créé par Windows' }, async (t) => {
  const { isPrivateAddress, lanAddresses } = await import('../src/lan.js');
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.20.1.1', '::ffff:192.168.0.2', '127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '193.168.1.1', '']) assert.equal(isPrivateAddress(ip), false, ip);
  const ips = lanAddresses();
  if (!ips.length) return t.skip('aucune carte réseau locale');
  const app = createApp({ config: testConfig({ LAN: 'true', LAN_PORT: '0' }), fishClient: fakeFish() });
  await app.listen(0);
  t.after(() => app.close());
  const lan = app.lan();
  assert.equal(lan.active, true, lan.error);
  const url = new URL(lan.urls[0]);
  // Requête HTTPS en acceptant le certificat auto-signé (test uniquement)
  const req = (method, pathname, { host = url.host, headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = https.request({ hostname: url.hostname, port: url.port, path: pathname, method, rejectUnauthorized: false, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
  assert.equal((await req('GET', '/login', { host: `exemple.com:${url.port}` })).status, 421, 'hôte inconnu refusé');
  assert.equal((await req('GET', '/login')).status, 200);
  const cer = await req('GET', '/capsule-studio-reseau.cer');
  assert.equal(cer.status, 200);
  assert.equal(cer.headers['content-type'], 'application/pkix-cert');
  const json = { 'Content-Type': 'application/json', 'X-Capsule-CSRF': '1', Origin: `https://${url.host}` };
  const setup = await req('POST', '/api/v1/session/setup', { headers: json, body: JSON.stringify({ password: 'motdepasse-solide' }) });
  assert.equal(setup.status, 200);
  assert.match(setup.headers['set-cookie'][0], /; Secure/);
  // Origine http (non chiffrée) refusée pour une mutation
  const bad = await req('POST', '/api/v1/session/login', { headers: { ...json, Origin: `http://${url.host}` }, body: JSON.stringify({ password: 'motdepasse-solide' }) });
  assert.equal(bad.status, 403);
});
