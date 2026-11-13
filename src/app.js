// Serveur HTTP sans framework : routes API, fichiers statiques, contrôles de sécurité.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.js';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createFishClient } from './fish.js';
import { createAudioStore } from './audio-store.js';
import { createServices, AppError } from './services.js';
import { buildZip } from './zip.js';
import { concatWav } from './audio.js';
import { registerSecret, redactDeep, redactString, log } from './redact.js';
import crypto from 'node:crypto';
import { lanAddresses, isPrivateAddress, ensureLanCert } from './lan.js';

// Empreinte du code serveur : détecte un serveur lancé avant une mise à jour
function serverCodeHash() {
  const h = crypto.createHash('sha256');
  for (const dir of ['src', 'shared']) {
    const full = path.join(APP_ROOT, dir);
    for (const f of fs.readdirSync(full).sort()) if (f.endsWith('.js')) h.update(fs.readFileSync(path.join(full, f)));
  }
  return h.digest('hex');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const STATIC_ROOTS = { '/shared/': path.join(APP_ROOT, 'shared'), '/': path.join(APP_ROOT, 'public') };
const COOKIE = 'cs_session';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; media-src 'self' blob: https://platform.r2.fish.audio; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new AppError(413, 'too_large', 'Requête trop volumineuse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  // UTF-8 strict : un texte mal encodé (ex. curl Windows) est refusé plutôt que corrompu
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
    throw new AppError(400, 'invalid_encoding', 'Corps de requête non encodé en UTF-8 : envoyez le JSON en UTF-8 (ex. curl --data-binary @fichier.json).');
  }
  try { return JSON.parse(text); } catch { throw new AppError(400, 'invalid_json', 'JSON invalide.'); }
}

export function createApp({ config, fishClient, fetchImpl } = {}) {
  registerSecret(config.fishApiKey);
  const store = createStore(config.dataDir);
  const auth = createAuth(store, config);
  const fish = fishClient ?? createFishClient({ apiKey: config.fishApiKey, fetchImpl, timeoutMs: config.providerTimeoutMs });
  const audioStore = createAudioStore(config.audioDir);
  const services = createServices({ store, config, fish, audioStore });
  let boundPort = config.port;

  // ---------- Réponses ----------
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (res, status, data, headers = {}) =>
    send(res, status, JSON.stringify(redactDeep(data)), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  // ---------- Contrôles d'origine ----------
  // Accès réseau local (LAN=true) : second serveur HTTPS, noms acceptés = adresses et nom du PC
  const lan = { server: null, port: null, names: [], urls: [], cerFile: null, error: null };
  const lanInfo = () => ({ enabled: config.lan, active: Boolean(lan.port), urls: lan.urls, error: lan.error });
  const secure = (req) => Boolean(req.socket.encrypted);
  const allowedHosts = (req) => (secure(req) ? lan.names.map((n) => `${n}:${lan.port}`) : [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  const hostOk = (req) => allowedHosts(req).includes(String(req.headers.host || '').toLowerCase());
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // requête non navigateur ou même origine sans en-tête
    const scheme = secure(req) ? 'https' : 'http';
    return allowedHosts(req).some((h) => origin === `${scheme}://${h}`);
  };
  // Cookie de session : « Secure » en HTTPS (réseau local)
  const cookieFlags = (req) => `HttpOnly; SameSite=Strict; Path=/${secure(req) ? '; Secure' : ''}`;

  // Identification : jeton Bearer → agent ; cookie de session → propriétaire
  function identify(req) {
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Bearer ')) {
      return auth.checkAgentToken(authz.slice(7).trim()) ? { role: 'agent' } : null;
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return auth.checkSession(token) ? { role: 'owner', viaCookie: true } : null;
  }

  // ---------- Routes ----------
  // [méthode, motif, gestionnaire, options] ; agent: true = accessible au jeton agent
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{1,64})'; }) + '$');
    routes.push({ method, pattern, re, keys, handler, opts });
  };

  // Session (publiques)
  route('GET', '/api/v1/session', (ctx) => ({ ownerExists: auth.ownerExists(), authenticated: ctx.actor?.role === 'owner' }), { public: true });
  route('POST', '/api/v1/session/setup', async (ctx) => {
    const body = await readJson(ctx.req);
    auth.setupOwner(body.password);
    return loginResponse(ctx, body.password);
  }, { public: true });
  route('POST', '/api/v1/session/login', async (ctx) => {
    const body = await readJson(ctx.req);
    return loginResponse(ctx, body.password);
  }, { public: true });
  route('POST', '/api/v1/session/logout', (ctx) => {
    auth.logout(parseCookies(ctx.req.headers.cookie)[COOKIE]);
    ctx.setHeaders['Set-Cookie'] = `${COOKIE}=; ${cookieFlags(ctx.req)}; Max-Age=0`;
    return { ok: true };
  });

  function loginResponse(ctx, password) {
    const token = auth.login(password, ctx.req.socket.remoteAddress);
    ctx.setHeaders['Set-Cookie'] = `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(ctx.req)}; Max-Age=${7 * 24 * 3600}`;
    return { ok: true };
  }

  // Capacités et réglages
  const startHash = serverCodeHash();
  route('GET', '/api/v1/capabilities', () => ({ ...services.capabilities(), serverOutdated: serverCodeHash() !== startHash }), { agent: true });
  route('GET', '/api/v1/settings', () => ({
    fishKeyStatus: config.fishApiKey ? 'configurée' : 'absente',
    settings: services.settingsView(),
    agentToken: auth.agentTokenState(),
    dataDir: config.dataDir,
    port: boundPort,
    lan: lanInfo(),
    ...services.capabilities()
  }));
  // Seule réponse non expurgée : le jeton agent, affiché une fois au propriétaire
  route('POST', '/api/v1/settings/agent-token', () => ({
    raw: true,
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ token: auth.generateAgentToken(), warning: 'Copiez ce jeton maintenant : il ne sera plus affiché.' })
  }));
  route('POST', '/api/v1/settings/agent-token/revoke', () => { auth.revokeAgentToken(); return { ok: true }; });
  // Réglages modifiables (clé Fish vérifiée avant enregistrement, jamais renvoyée)
  route('POST', '/api/v1/settings', async (ctx) => services.updateSettings(ctx.actor, await readJson(ctx.req)));
  route('POST', '/api/v1/settings/agent-autonomy', async (ctx) => services.setAgentAutonomy(ctx.actor, await readJson(ctx.req)));

  // Projets, segments, révisions
  route('GET', '/api/v1/projects', () => ({ items: services.listProjects() }), { agent: true });
  route('POST', '/api/v1/projects', async (ctx) => services.createProject(ctx.actor, await readJson(ctx.req)), { autonomous: true });
  route('GET', '/api/v1/projects/:id', (ctx) => services.getProject(ctx.params.id), { agent: true });
  route('POST', '/api/v1/projects/:id/montage', async (ctx) => services.setProjectMontage(ctx.actor, ctx.params.id, await readJson(ctx.req)), { autonomous: true });
  // Musique de fond : fichier brut dans le corps, nom d'origine dans l'en-tête X-Filename (encodé URI)
  route('POST', '/api/v1/projects/:id/music', async (ctx) => {
    if (ctx.actor.role !== 'owner') throw new AppError(403, 'forbidden', 'Action réservée au propriétaire.');
    const buffer = await readBody(ctx.req, 100 * 1024 * 1024);
    let name = '';
    try { name = decodeURIComponent(String(ctx.req.headers['x-filename'] || '')); } catch { name = ''; }
    return services.setProjectMusic(ctx.actor, ctx.params.id, { buffer, name });
  });
  route('POST', '/api/v1/projects/:id/music/remove', (ctx) => services.removeProjectMusic(ctx.actor, ctx.params.id));
  route('GET', '/api/v1/projects/:id/music', (ctx) => {
    const { data, mime } = services.getProjectMusic(ctx.params.id);
    return { raw: true, status: 200, body: data, headers: { 'Content-Type': mime, 'Content-Disposition': 'inline' } };
  });
  route('POST', '/api/v1/projects/:id/cast', async (ctx) => services.setProjectCast(ctx.actor, ctx.params.id, await readJson(ctx.req)), { autonomous: true });
  route('POST', '/api/v1/segments/:id/speaker', async (ctx) => services.setSegmentSpeaker(ctx.actor, ctx.params.id, (await readJson(ctx.req)).speaker), { autonomous: true });
  route('POST', '/api/v1/projects/:id/archive', (ctx) => services.archiveProject(ctx.actor, ctx.params.id));
  route('POST', '/api/v1/projects/:id/segments', async (ctx) => services.createSegment(ctx.actor, ctx.params.id, await readJson(ctx.req)), { autonomous: true });
  route('POST', '/api/v1/segments/:id/revisions', async (ctx) => services.createRevision(ctx.actor, ctx.params.id, await readJson(ctx.req)), { autonomous: true });
  route('POST', '/api/v1/segments/:id/choose', async (ctx) => services.chooseTake(ctx.actor, ctx.params.id, (await readJson(ctx.req)).takeId ?? null), { autonomous: true });
  route('POST', '/api/v1/segments/:id/move', async (ctx) => services.moveSegment(ctx.actor, ctx.params.id, (await readJson(ctx.req)).direction), { autonomous: true });
  route('POST', '/api/v1/segments/:id/archive', (ctx) => services.archiveSegment(ctx.actor, ctx.params.id));

  // Voix
  route('GET', '/api/v1/voices', (ctx) => ({ items: services.listVoices(ctx.actor) }), { agent: true });
  route('GET', '/api/v1/voices/catalog', (ctx) => {
    const sp = ctx.url.searchParams;
    return services.searchCatalog(ctx.actor, { tags: (sp.get('tags') || '').split(',').filter(Boolean), all: sp.get('all') === '1', page: sp.has('page') ? Number(sp.get('page')) : 1 });
  });
  route('GET', '/api/v1/voices/account', (ctx) => services.listAccountVoices(ctx.actor));
  route('POST', '/api/v1/voices/import',async (ctx) => services.importVoice(ctx.actor, await readJson(ctx.req)));
  route('POST', '/api/v1/voices/:id/verify', (ctx) => services.refreshVoice(ctx.actor, ctx.params.id));
  route('POST', '/api/v1/voices/:id/archive', (ctx) => services.archiveVoice(ctx.actor, ctx.params.id));
  route('POST', '/api/v1/voices/clone', async (ctx) => {
    if (ctx.actor.role !== 'owner') throw new AppError(403, 'forbidden', 'Action réservée au propriétaire.');
    const buf = await readBody(ctx.req, 21 * 1024 * 1024);
    let form;
    try {
      form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ctx.req.headers['content-type'] || '' }, body: buf }).formData();
    } catch {
      throw new AppError(400, 'invalid_form', 'Formulaire multipart invalide.');
    }
    const file = form.get('file');
    return services.cloneVoice(ctx.actor, {
      title: form.get('title'),
      transcript: form.get('transcript') || '',
      consent: form.get('consent') === 'true',
      enhanceAudio: form.get('enhanceAudio') === 'true',
      file: file && typeof file.arrayBuffer === 'function' ? Buffer.from(await file.arrayBuffer()) : null
    });
  });

  // Propositions de l'agent
  route('GET', '/api/v1/proposals', (ctx) => ({ items: services.listProposals(ctx.url.searchParams.get('state')) }), { agent: true });
  route('POST', '/api/v1/proposals', async (ctx) => services.createProposal(ctx.actor, await readJson(ctx.req)), { agent: true, status: 201 });
  route('GET', '/api/v1/proposals/:id', (ctx) => services.getProposal(ctx.params.id), { agent: true });
  route('POST', '/api/v1/proposals/:id/decision', async (ctx) => services.decideProposal(ctx.actor, ctx.params.id, await readJson(ctx.req)));

  // Plans, approbations, générations
  route('POST', '/api/v1/generation-plans', async (ctx) => services.createPlan(ctx.actor, await readJson(ctx.req)), { agent: true, status: 201 });
  route('GET', '/api/v1/generation-plans/:id', (ctx) => services.getPlan(ctx.params.id), { agent: true });
  route('POST', '/api/v1/generation-plans/:id/approve', (ctx) => services.approvePlan(ctx.actor, ctx.params.id), { autonomous: true });
  route('POST', '/api/v1/generations', async (ctx) => {
    const body = await readJson(ctx.req);
    const { job, reused } = services.executePlan(ctx.actor, { planId: body.planId, idempotencyKey: ctx.req.headers['idempotency-key'] });
    ctx.status = reused ? 200 : 202;
    return job;
  }, { agent: true });
  route('GET', '/api/v1/generations/:id', (ctx) => services.getGeneration(ctx.params.id), { agent: true });

  // Audio et exports (contrôle d'accès conservé)
  route('GET', '/api/v1/takes/:id/audio', (ctx) => {
    const take = services.getTake(ctx.params.id);
    const data = audioStore.read(take.file);
    const download = ctx.url.searchParams.get('download') === '1';
    const ext = take.file.endsWith('.wav') ? 'wav' : 'mp3';
    const headers = {
      'Content-Type': ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="capsule-${take.id}.${ext}"`
    };
    // Prise en charge des plages (navigation dans le lecteur audio)
    const range = /^bytes=(\d*)-(\d*)$/.exec(ctx.req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? data.length - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : data.length - 1;
      if (start < 0) start = 0;
      end = Math.min(end, data.length - 1);
      if (start > end) return { raw: true, status: 416, body: '', headers: { 'Content-Range': `bytes */${data.length}` } };
      return { raw: true, status: 206, body: data.subarray(start, end + 1), headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}` } };
    }
    return { raw: true, status: 200, body: data, headers };
  }, { agent: true });

  route('POST', '/api/v1/exports', async (ctx) => {
    const body = await readJson(ctx.req);
    const ids = Array.isArray(body.takeIds) ? body.takeIds : [];
    if (!ids.length || ids.length > 50) throw new AppError(400, 'invalid', 'Liste de prises attendue (1 à 50).');
    const takes = ids.map((id) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError(400, 'invalid', 'Identifiant de prise invalide.');
      return services.getTake(id);
    });
    // Ordre : ordre des segments, puis date
    const segOrder = (t) => store.get('segments', t.segmentId)?.order ?? 0;
    takes.sort((a, b) => segOrder(a) - segOrder(b) || a.createdAt.localeCompare(b.createdAt));
    // Noms lisibles pour un logiciel vidéo (HeyGen…) : « 01-ALEX.wav » en dialogue, « 01-titre-du-segment.wav » en monologue
    const slug = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const firstSeg = store.get('segments', takes[0].segmentId);
    const project = firstSeg ? store.get('projects', firstSeg.projectId) : null;
    const dialogue = project?.mode === 'dialogue';
    const who = (t) => {
      const seg = store.get('segments', t.segmentId);
      if (dialogue) { const sp = seg?.speaker ?? 'A'; return slug(sp === 'A' ? project.nameA : project.nameB) || sp; }
      return slug(seg?.title) || 'segment';
    };
    const entries = takes.map((t, i) => ({ name: `${String(i + 1).padStart(2, '0')}-${who(t)}.${t.file.split('.').pop()}`, data: audioStore.read(t.file) }));
    const manifest = {
      app: 'Capsule Studio', exportedAt: new Date().toISOString(),
      note: 'Fichiers bruts générés par Fish Audio, non assemblés.',
      takes: takes.map((t, i) => {
        const v = services.takeView(t);
        return { order: i + 1, file: entries[i].name, segmentId: v.segmentId, speaker: dialogue ? (store.get('segments', t.segmentId)?.speaker ?? 'A') : null, modelRequested: v.modelRequested, voiceName: v.voiceName, instruction: v.instruction, finalText: v.finalText, durationSec: v.durationSec, createdAt: v.createdAt };
      })
    };
    entries.push({ name: 'manifeste.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
    return { raw: true, status: 200, body: buildZip(entries), headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${slug(project?.name) || 'capsule'}-repliques.zip"` } };
  }, { agent: true });

  // Capsule assemblée : prises retenues mises bout à bout dans un seul WAV
  route('POST', '/api/v1/exports/wav', async (ctx) => {
    const body = await readJson(ctx.req);
    const ids = Array.isArray(body.takeIds) ? body.takeIds : [];
    if (!ids.length || ids.length > 200) throw new AppError(400, 'invalid', 'Liste de prises attendue (1 à 200).');
    const gapMs = body.gapMs ?? 0;
    if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 5000) throw new AppError(400, 'invalid', 'Silence entre segments invalide (0 à 5000 ms).');
    const takes = ids.map((id) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError(400, 'invalid', 'Identifiant de prise invalide.');
      return services.getTake(id);
    });
    const segOrder = (t) => store.get('segments', t.segmentId)?.order ?? 0;
    takes.sort((a, b) => segOrder(a) - segOrder(b) || a.createdAt.localeCompare(b.createdAt));
    const result = concatWav(takes.map((t) => audioStore.read(t.file)), gapMs / 1000);
    if (result.error) {
      const seg = store.get('segments', takes[result.index].segmentId);
      const name = seg?.title ? `« ${seg.title} »` : `n° ${result.index + 1}`;
      const why = result.error === 'format_mismatch' ? 'n’a pas le même format que les autres' : 'n’est pas en WAV';
      throw new AppError(400, 'invalid_audio', `La prise retenue du segment ${name} ${why} : régénérez-la en WAV 44,1 kHz.`);
    }
    return { raw: true, status: 200, body: result.wav, headers: { 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="capsule.wav"' } };
  }, { agent: true });

  // Projet de démonstration (textes fictifs clairement identifiés)
  route('POST', '/api/v1/demo', (ctx) => {
    const p = services.createProject(ctx.actor, { name: 'Introduction de tutoriel (démo)' });
    const demo = [
      ['Accroche', 'Il reste une copie. On peut encore tout récupérer.', '[calm]'],
      ['Le risque', 'Un seul dossier, une seule copie : il suffit d’un disque qui lâche pour tout perdre.', ''],
      ['La solution', 'Avant de modifier votre projet, gardez une copie de vos fichiers ailleurs.', '[calm]']
    ];
    for (const [title, spokenText, instruction] of demo) services.createSegment(ctx.actor, p.id, { title, spokenText, instruction });
    return services.getProject(p.id);
  });

  // ---------- Fichiers statiques ----------
  function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/login') pathname = '/login.html';
    const prefix = pathname.startsWith('/shared/') ? '/shared/' : '/';
    const root = STATIC_ROOTS[prefix];
    const full = path.resolve(root, '.' + pathname.slice(prefix.length - 1));
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return send(res, 404, 'Introuvable', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    // Pages protégées : redirection vers la connexion
    if (pathname === '/index.html' && !identify(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  }

  // ---------- Aiguillage ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      // Réseau local : seuls les postes d'adresse privée sont servis
      if (secure(req) && !isPrivateAddress(req.socket.remoteAddress)) return send(res, 403, 'Réservé au réseau local', { 'Content-Type': 'text/plain; charset=utf-8' });
      // Anti-rebinding DNS : seul l'hôte local est accepté
      if (!hostOk(req)) return send(res, 421, 'Hôte refusé', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');
        // Certificat public du réseau local, à installer sur les autres postes
        if (url.pathname === '/capsule-studio-reseau.cer' && lan.cerFile) {
          return send(res, 200, fs.readFileSync(lan.cerFile), { 'Content-Type': 'application/pkix-cert', 'Content-Disposition': 'attachment; filename="capsule-studio-reseau.cer"' });
        }
        return serveStatic(req, res, url);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return json(res, 404, { error: { code: 'not_found', message: 'Route inconnue.' } });
      const actor = identify(req);
      if (!r.opts.public && !actor) throw new AppError(401, 'unauthenticated', 'Authentification requise.');
      // Routes « autonomous » : ouvertes à l'agent, le service vérifie que le mode autonome est actif
      if (actor?.role === 'agent' && !r.opts.agent && !r.opts.autonomous) throw new AppError(403, 'forbidden', 'Route réservée au propriétaire.');
      // Mutations web : origine locale et en-tête anti-CSRF obligatoires
      if (req.method !== 'GET' && (actor?.viaCookie || r.opts.public)) {
        if (!originOk(req) || req.headers['x-capsule-csrf'] !== '1') throw new AppError(403, 'csrf', 'Requête refusée (origine ou jeton anti-CSRF).');
      }
      const m = r.re.exec(url.pathname);
      const ctx = { req, url, actor, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])), setHeaders: {}, status: r.opts.status ?? 200 };
      const result = await r.handler(ctx);
      if (result?.raw) return send(res, result.status, result.body, { ...result.headers, ...ctx.setHeaders });
      return json(res, ctx.status, result, ctx.setHeaders);
    } catch (e) {
      if (e instanceof AppError) {
        log({ event: 'request_error', route: url.pathname, status: e.status, code: e.code });
        return json(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
      }
      log({ event: 'internal_error', route: url.pathname, code: redactString(e?.message).slice(0, 120) });
      return json(res, 500, { error: { code: 'internal', message: 'Erreur interne.' } });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  // Second serveur HTTPS pour le réseau local ; en cas d'échec, l'accès sur ce PC reste disponible
  function startLan() {
    return new Promise((resolve) => {
      try {
        const ips = lanAddresses();
        if (!ips.length) throw new Error('aucune adresse réseau local trouvée');
        const cert = ensureLanCert(config.dataDir, ips);
        lan.cerFile = cert.cerFile;
        lan.names = [...ips, os.hostname().toLowerCase(), 'localhost', '127.0.0.1'];
        lan.server = https.createServer({ pfx: cert.pfx, passphrase: cert.passphrase }, (req, res) => { handle(req, res); });
        lan.server.once('error', (e) => { lan.error = e.code === 'EADDRINUSE' ? `port ${config.lanPort} déjà utilisé` : (e.code || e.message); lan.server = null; resolve(); });
        lan.server.listen(config.lanPort, '0.0.0.0', () => {
          lan.port = lan.server.address().port;
          lan.urls = [...ips, os.hostname().toLowerCase()].map((n) => `https://${n}:${lan.port}`);
          resolve();
        });
      } catch (e) {
        lan.error = redactString(e.message).slice(0, 200);
        resolve();
      }
    });
  }
  return {
    server, services, store, auth, config,
    lan: lanInfo,
    routes: () => routes.map((r) => ({ method: r.method, path: r.pattern.replace(/:(\w+)/g, '{$1}'), agent: Boolean(r.opts.agent), autonomous: Boolean(r.opts.autonomous), public: Boolean(r.opts.public) })),
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.host, async () => {
          boundPort = server.address().port;
          if (config.lan) await startLan();
          services.recoverAfterRestart();
          resolve(boundPort);
        });
      });
    },
    close() {
      lan.server?.close();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
