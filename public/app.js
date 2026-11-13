// Capsule Studio : interface web. Aucun secret ici, aucun appel direct à Fish Audio.
import { INTENTS, buildFinalText, utf8Bytes, buildTtsBody, redactedRequest, estimateUsd, FISH_TTS_URL, cleanAudioOptions, audioOptionsLabel, VOLUME_STEPS, FORMATS, SAMPLE_RATES, normalizeInstruction, VOICE_TAG_GROUPS, VOICE_TAGS } from '/shared/payload.js';
import { createMontage } from '/montage.js';

// ---------- Utilitaires DOM (textContent uniquement : aucun HTML injecté) ----------
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
// Remplit ou complète un élément en ignorant null/undefined/false (sinon le DOM affiche « null »)
const clean = (kids) => kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
const fill = (el, ...kids) => el.replaceChildren(...clean(kids));
const add = (el, ...kids) => el.append(...clean(kids));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2).replace('.', ',')} s`);
const fmtSec = (s) => (s === null || s === undefined ? 'durée non mesurée' : `${String(s.toFixed(1)).replace('.', ',')} s`);
const fmtUsd = (usd) => (usd === null || usd === undefined ? 'inconnu' : `${usd.toFixed(usd === 0 ? 0 : 6)} $`);
const store = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible : préférence non mémorisée */ } }
};

function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}`, role: type === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Capsule-CSRF': '1', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Session expirée.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || `Erreur ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- État ----------
const S = {
  caps: null,
  projects: [],
  projectId: store.get('cs.project'),
  project: null,
  segmentId: null,
  voices: [],
  voiceId: store.get('cs.voice'),
  modelKey: store.get('cs.model', 's21_free'),
  jobs: new Map(),
  panelJobId: null,
  ab: { A: null, B: null },
  compare: new Set(),
  draft: null,
  confirmBatch: false,
  pendingProposals: 0,
  filming: store.get('cs.filming') === '1',
  // Panneau API ouvert par défaut seulement sur grand écran
  apiOpen: store.get('cs.apiPanel', window.innerWidth >= 1500 ? '1' : '0') === '1',
  showCompare: false,
  customOpen: false,
  abPlaying: null,
  // Réglages audio Fish Audio (normalisation, volume) mémorisés entre les sessions
  audio: (() => { try { return cleanAudioOptions(JSON.parse(store.get('cs.audio', 'null'))) ?? cleanAudioOptions(); } catch { return cleanAudioOptions(); } })(),
  showAudio: false,
  showTags: false,
  // Génération en chaîne en cours : { stop }
  batchRun: null,
  // Cadre des prises : vue d'ensemble de toute la capsule
  showOverview: false,
  // « Tout régénérer » coché dans le panneau de génération en chaîne
  genAllForce: false
};

// Migration unique : l'ancien défaut 0 dB mémorisé passe au nouveau défaut -1 dB
if (!store.get('cs.audio.default-1db') && S.audio.volumeDb === 0) {
  S.audio = { ...S.audio, volumeDb: -1 };
  store.set('cs.audio', JSON.stringify(S.audio));
}
store.set('cs.audio.default-1db', '1');

const segment = () => S.project?.segments.find((s) => s.id === S.segmentId) ?? null;
const modelInfo = (key) => S.caps?.models.find((m) => m.key === key) ?? null;
const voice = (id) => S.voices.find((v) => v.id === id) ?? null;
const readyVoices = () => S.voices.filter((v) => v.state === 'ready');
const intentLabel = (instruction) => INTENTS.find((i) => i.tag === (instruction || ''))?.label ?? (instruction || 'Neutre');
// Nom d'une prise ou d'un segment : toutes les balises du texte final (ton de départ compris), en français,
// sans les pauses ; « Neutre » seulement s'il n'y a aucune balise
function toneLabel(finalText) {
  const names = new Map(TAG_GROUPS.filter((g) => g.label !== 'Pauses').flatMap((g) => g.tags.map(([fr, tag]) => [tag, fr])));
  const pauses = new Set(TAG_GROUPS.filter((g) => g.label === 'Pauses').flatMap((g) => g.tags.map(([, tag]) => tag)));
  const seen = [];
  for (const tag of String(finalText ?? '').match(/\[[^\]]+\]/g) ?? []) {
    if (pauses.has(tag)) continue;
    const label = names.get(tag) ?? tag.slice(1, -1);
    if (!seen.includes(label)) seen.push(label);
  }
  if (!seen.length) return 'Neutre';
  return seen.length > 4 ? `${seen.slice(0, 4).join(' · ')} +${seen.length - 4}` : seen.join(' · ');
}
// Texte actuel du segment d'une génération, avec le ton de départ de cette génération
const jobText = (j) => buildFinalText(S.project?.segments.find((x) => x.id === j.segmentId)?.revision.spokenText ?? '', j.instruction);

// ---------- Thème et mode tournage ----------
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const btn = $('#theme-btn');
  btn.textContent = isDark() ? '☀' : '☾';
  btn.title = isDark() ? 'Passer en thème clair' : 'Passer en thème sombre';
  // Les formes d'onde lisent les couleurs du thème
  try { players.forEach((p) => drawWave(p)); } catch { /* lecteurs pas encore initialisés au démarrage */ }
}
applyTheme(store.get('cs.theme'));
$('#theme-btn').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  applyTheme(next);
  store.set('cs.theme', next);
});

function applyFilming() {
  document.body.classList.toggle('filming', S.filming);
  $('#filming-btn').setAttribute('aria-pressed', String(S.filming));
}
$('#filming-btn').addEventListener('click', () => {
  S.filming = !S.filming;
  store.set('cs.filming', S.filming ? '1' : '0');
  applyFilming();
  route();
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/v1/session/logout');
  location.href = '/login';
});

// Un seul lecteur à la fois (A/B, prises, liste de lecture)
document.addEventListener('play', (e) => {
  document.querySelectorAll('audio').forEach((a) => { if (a !== e.target) a.pause(); });
}, true);

// ---------- Chargements ----------
async function loadCaps() {
  S.caps = await api('GET', '/api/v1/capabilities');
  // Étiquette d'instance (APP_LABEL) : distingue une copie de développement
  const label = $('#instance-label');
  if (label) { label.textContent = S.caps.instanceLabel || ''; label.hidden = !S.caps.instanceLabel; }
  if (S.caps.instanceLabel) document.title = `Capsule Studio · ${S.caps.instanceLabel}`;
  const key = $('#key-status');
  key.className = `pill ${S.caps.fishConfigured ? 'ok' : 'warn'}`;
  key.textContent = S.caps.fishConfigured ? 'Clé configurée' : 'Clé absente';
  key.title = S.caps.fishConfigured ? 'Clé Fish Audio configurée côté serveur' : 'Clé Fish Audio absente : voir Réglages';
  const offer = S.caps.freeOffer;
  const banner = $('#offer-banner');
  fill(banner, );
  if (offer.active) {
    const end = new Date(`${offer.endDate}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    banner.className = 'offer-banner';
    add(banner, `S2.1 Pro Free : accès API gratuit jusqu’au ${end}, sous conditions. `,
      h('span', { class: 'muted' }, `Vérifié le ${new Date(offer.verifiedAt).toLocaleDateString('fr-FR')} · `),
      h('a', { href: offer.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Conditions'));
  } else {
    banner.className = 'offer-banner expired';
    add(banner, 'L’offre S2.1 Pro Free est terminée : modèle gratuit bloqué. Activez les générations payantes dans ',
      h('a', { href: '#/reglages' }, 'Réglages'), ' (ou corrigez la date si Fish Audio a prolongé l’offre). ',
      h('a', { href: offer.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Conditions'));
  }
  if (!modelInfo(S.modelKey)) S.modelKey = S.caps.defaultModelKey;
  if (S.caps.serverOutdated) {
    key.className = 'pill danger';
    key.textContent = 'Serveur à relancer';
    key.title = 'Le code a été mis à jour depuis le démarrage du serveur : relancez lancer-capsule-studio.bat.';
  }
}

async function loadProjects() {
  S.projects = (await api('GET', '/api/v1/projects')).items;
  if (!S.projects.find((p) => p.id === S.projectId)) S.projectId = S.projects[0]?.id ?? null;
  const sel = $('#project-select');
  fill(sel, ...S.projects.map((p) => h('option', { value: p.id, selected: p.id === S.projectId }, p.name)));
  sel.disabled = !S.projects.length;
  sel.hidden = !S.projects.length;
  if (S.projectId) await loadProject();
  else S.project = null;
}

async function loadProject() {
  S.project = await api('GET', `/api/v1/projects/${S.projectId}`);
  store.set('cs.project', S.projectId);
  if (!S.project.segments.find((s) => s.id === S.segmentId)) {
    S.segmentId = S.project.segments[0]?.id ?? null;
    S.draft = null;
  }
}

async function loadVoices() {
  S.voices = (await api('GET', '/api/v1/voices')).items;
  if (!readyVoices().find((v) => v.id === S.voiceId)) S.voiceId = readyVoices()[0]?.id ?? null;
}

async function refreshProposalBadge() {
  try {
    const { items } = await api('GET', '/api/v1/proposals?state=proposed');
    const changed = items.length !== S.pendingProposals;
    S.pendingProposals = items.length;
    const b = $('#proposal-badge');
    b.hidden = !items.length;
    b.textContent = String(items.length);
    if (changed && items.length && location.hash.startsWith('#/propositions')) renderProposals();
  } catch { /* hors ligne : badge inchangé */ }
}

$('#project-select').addEventListener('change', async (e) => {
  S.projectId = e.target.value;
  S.segmentId = null;
  S.draft = null;
  S.ab = { A: null, B: null };
  await loadProject();
  route();
});

$('#new-project-btn').addEventListener('click', () => {
  const view = $('#view');
  const input = h('input', { type: 'text', id: 'np-name', maxlength: '120', required: true });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    if (!input.value.trim()) { err.textContent = 'Nom requis.'; return; }
    try {
      const p = await api('POST', '/api/v1/projects', { name: input.value });
      S.projectId = p.id;
      await loadProjects();
      location.hash = '#/studio';
      route();
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('h2', {}, 'Nouveau projet'), h('label', { for: 'np-name' }, 'Nom du projet'), input, err,
  h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Créer'), h('a', { href: '#/studio', class: 'btn ghost' }, 'Annuler')));
  fill(view, form);
  input.focus();
});

// ---------- Routage ----------
// Page Montage : ligne de temps des prises retenues (module séparé)
const montage = createMontage({
  h, fill, toast, store, voice, api,
  project: () => S.project,
  monoVoiceId: () => S.voiceId,
  openSegment: (id) => { location.hash = '#/studio'; selectSegment(id); }
});

function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'studio';
  if (name !== 'montage') montage.leave();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  ({ studio: renderStudio, montage: () => montage.render($('#view')), voix: openVoices, propositions: renderProposals, reglages: renderSettings }[name] || renderStudio)();
}
window.addEventListener('hashchange', route);

// =====================================================================
// STUDIO
// =====================================================================
// Balises S2 documentées par Fish Audio (docs.fish.audio, Emotion Control, vérifié le 2026-10-23)
const TAG_GROUPS = [
  { label: 'Émotions', tags: [['Joyeux', '[happy]'], ['Triste', '[sad]'], ['En colère', '[angry]'], ['Enthousiaste', '[excited]'], ['Calme', '[calm]'], ['Nerveux', '[nervous]'], ['Confiant', '[confident]'], ['Surpris', '[surprised]'], ['Inquiet', '[worried]'], ['Curieux', '[curious]'], ['Sarcastique', '[sarcastic]'], ['Ému', '[moved]'], ['Fier', '[proud]'], ['Détendu', '[relaxed]'], ['Déterminé', '[determined]'], ['Nostalgique', '[nostalgic]'], ['Hésitant', '[uncertain]'], ['Déçu', '[disappointed]'], ['Méprisant', '[contemptuous]'], ['Dédaigneux', '[disdainful]'], ['Contrarié', '[upset]'], ['Agacé', '[frustrated]'], ['Dubitatif', '[doubtful]'], ['Perplexe', '[confused]'], ['Gêné', '[embarrassed]'], ['Indifférent', '[indifferent]']] },
  { label: 'Ton', tags: [['Chuchoté', '[whispering]'], ['Voix douce', '[soft tone]'], ['Pressé', '[in a hurry tone]'], ['Crié', '[shouting]'], ['Insistance', '[emphasis]']] },
  // Descriptions libres acceptées par S2 mais sans balise documentée : rendu non garanti
  { label: 'Libres', free: true, tags: [['Interrogatif', '[questioning tone]'], ['Vexé', '[offended]'], ['Choqué', '[shocked]'], ['Moqueur', '[mocking]']] },
  { label: 'Sons', tags: [['Rire', '[laughing]'], ['Petit rire', '[chuckling]'], ['Soupir', '[sighing]'], ['Souffle coupé', '[gasping]'], ['Raclement de gorge', '[clear throat]'], ['Bâillement', '[yawning]']] },
  { label: 'Pauses', tags: [['Pause', '[break]'], ['Longue pause', '[long-break]']] }
];
const INTENT_ICONS = { neutral: '○', calm: '☾', worried: '!', excited: '✦', whisper: '…' };
const fmtHM = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

function renderStudio() {
  const view = $('#view');
  if (!S.project) { renderWelcome(view); return; }
  fill(view, h('div', { class: `studio ${S.apiOpen ? 'api-open' : ''}` },
    h('div', { class: 'studio-center' },
      h('div', { class: 'cast-bar', id: 'cast-bar' }),
      h('div', { class: 'tabs-row', id: 'tabs-row' }),
      h('div', { id: 'new-seg-zone' }),
      h('section', { class: 'card editor', id: 'editor-card', 'aria-label': 'Texte et génération' }),
      h('section', { class: 'card', id: 'takes-card', 'aria-label': 'Prises' })),
    S.apiOpen ? h('aside', { class: 'api-drawer', id: 'api-col', 'aria-label': 'Voir l’API' }) : null));
  renderCast();
  renderTabs();
  renderEditor();
  renderTakes();
  renderApiPanel();
}

function renderWelcome(view) {
  const v = readyVoices()[0];
  const text = h('textarea', { class: 'script-input welcome-input', id: 'first-text', rows: '2', placeholder: 'Il reste une copie. On peut encore tout récupérer.', 'aria-label': 'Votre première phrase' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const start = async () => {
    const spokenText = text.value.trim() || text.placeholder;
    try {
      const p = await api('POST', '/api/v1/projects', { name: 'Ma première capsule' });
      await api('POST', `/api/v1/projects/${p.id}/segments`, { title: 'Phrase 1', spokenText, instruction: '[calm]' });
      S.projectId = p.id;
      await loadProjects();
      route();
    } catch (e) { err.textContent = e.message; }
  };
  const step = (n, title, body, done) => h('div', { class: `step ${done ? 'done' : ''}` },
    h('span', { class: 'step-n' }, done ? '✓' : String(n)), h('b', {}, title), h('p', { class: 'muted small' }, body));
  fill(view, h('div', { class: 'welcome' },
    h('h1', { class: 'serif' }, 'Votre studio de voix off'),
    h('p', { class: 'welcome-sub' }, 'Vous écrivez une phrase, vous choisissez le ton, Fish Audio la dit avec votre voix. Vous écoutez, vous comparez, vous gardez la meilleure prise.'),
    S.caps.fishConfigured ? null : fishKeyCard({ intro: true, onSaved: () => renderWelcomeAgain() }),
    h('div', { class: 'steps' },
      step(1, 'Une voix', v ? `« ${v.name} » est prête.` : 'Ajoutez votre voix dans l’onglet Voix.', Boolean(v)),
      step(2, 'Un texte', 'Ce que la voix doit dire, phrase par phrase.', false),
      step(3, 'L’écoute', 'Calme, inquiet, enthousiaste… même texte, plusieurs tons.', false)),
    h('section', { class: 'card welcome-card' },
      h('div', { class: 'label' }, 'Votre première phrase'),
      h('div', { class: 'script-line' }, h('span', { class: 'script-tag' }, '[calm]'), text),
      err,
      h('div', { class: 'row welcome-actions' },
        v ? h('button', { class: 'go', type: 'button', onclick: start }, 'Commencer') : h('a', { class: 'go', href: '#/voix' }, 'Ajouter ma voix d’abord'),
        h('button', { class: 'btn ghost', type: 'button', onclick: createDemo }, 'ou ouvrir le projet de démonstration')))));
  text.focus();
}

function toggleApi(open = !S.apiOpen) {
  S.apiOpen = open;
  store.set('cs.apiPanel', open ? '1' : '0');
  renderStudio();
}

async function createDemo() {
  try {
    const p = await api('POST', '/api/v1/demo');
    S.projectId = p.id;
    await loadProjects();
    location.hash = '#/studio';
    route();
    toast('Projet de démonstration créé (textes fictifs).');
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Onglets des segments ----------
const chosenTakes = () => S.project.segments.map((s) => s.takes.find((t) => t.id === s.chosenTakeId)).filter(Boolean);

// Mode du projet : une voix (monologue) ou deux voix A/B (dialogue)
async function saveCast(patch) {
  const p = S.project;
  try {
    S.project = await api('POST', `/api/v1/projects/${p.id}/cast`, { mode: p.mode, voices: p.voices, names: p.names, ...patch });
    renderStudio();
  } catch (e) { toast(e.message, 'error'); }
}

function renderCast() {
  const bar = $('#cast-bar');
  if (!bar) return;
  const p = S.project;
  const voices = readyVoices();
  const modeBtn = (mode, label) => h('button', {
    type: 'button', class: 'mode-btn', 'aria-pressed': String(p.mode === mode),
    // Passage en dialogue : la voix actuelle devient la voix A
    onclick: () => { if (p.mode !== mode) saveCast({ mode, voices: mode === 'dialogue' && !p.voices.A ? { ...p.voices, A: S.voiceId } : p.voices }); }
  }, label);
  const castFor = (k) => {
    const sel = h('select', { id: `cast-${k}`, 'aria-label': `Voix de l’intervenant ${k}` },
      h('option', { value: '' }, 'Choisir une voix…'),
      voices.map((v) => h('option', { value: v.id, selected: v.id === p.voices[k] }, v.name)));
    sel.addEventListener('change', () => saveCast({ voices: { ...p.voices, [k]: sel.value || null } }));
    const name = h('input', { type: 'text', class: 'cast-name', maxlength: '40', value: p.names[k], placeholder: `Nom (ex. ${k === 'A' ? 'ALEX' : 'SAM'})`, 'aria-label': `Nom de l’intervenant ${k}` });
    name.addEventListener('change', () => saveCast({ names: { ...p.names, [k]: name.value.trim() } }));
    return h('div', { class: `cast-slot spk-${k}` }, h('span', { class: `spk spk-${k}` }, k), name, sel);
  };
  fill(bar,
    h('div', { class: 'mode-switch', role: 'group', 'aria-label': 'Mode du projet' }, modeBtn('mono', 'Monologue'), modeBtn('dialogue', 'Dialogue')),
    p.mode === 'dialogue' ? [castFor('A'), castFor('B'),
      !voices.length ? h('a', { href: '#/voix', class: 'small' }, 'Ajouter une voix') : null] : null);
}

function renderTabs() {
  const row = $('#tabs-row');
  if (!row) return;
  const segs = S.project.segments;
  const kept = chosenTakes();
  fill(row,
    segs.map((s, i) => {
      const tab = h('button', {
        type: 'button', class: 'seg-tab', 'aria-current': s.id === S.segmentId ? 'true' : null,
        title: s.revision?.spokenText ?? '', onclick: () => selectSegment(s.id)
      },
      h('span', { class: 'n' }, String(i + 1)),
      h('span', { class: 'tab-title' }, s.title || `Segment ${i + 1}`),
      s.chosenTakeId ? h('span', { class: 'ok', 'aria-label': 'prise retenue' }, '✓') : null);
      if (!isDialogue()) return tab;
      // Un clic sur la pastille inverse l'intervenant du segment
      const other = s.speaker === 'A' ? 'B' : 'A';
      return h('span', { class: 'tab-wrap' },
        h('button', { type: 'button', class: `spk spk-${s.speaker}`, title: `${speakerName(s.speaker)} : cliquer pour passer à ${speakerName(other)}`, 'aria-label': `Intervenant ${speakerName(s.speaker)}, passer à ${speakerName(other)}`,
          onclick: async () => {
            try { S.project = await api('POST', `/api/v1/segments/${s.id}/speaker`, { speaker: other }); renderStudio(); } catch (e) { toast(e.message, 'error'); }
          } }, s.speaker),
        tab);
    }),
    h('button', { type: 'button', class: 'seg-tab add', onclick: toggleNewSegment }, '+ Segment'),
    h('button', { type: 'button', class: 'seg-tab add', onclick: toggleImport }, '⤒ Importer un script'),
    h('div', { class: 'tabs-tools' },
      h('button', { type: 'button', class: 'btn small', id: 'playlist-btn', disabled: !kept.length, onclick: () => togglePlaylist(kept) },
        playlist ? `■ Arrêter (${playlist.i} / ${playlist.takes.length})` : '▶ Écouter la capsule'),
      h('button', { type: 'button', class: 'btn small', disabled: Boolean(S.batchRun) || !segs.length, title: 'Générer dans l’ordre les segments à faire', onclick: () => toggleGenerateAll() }, S.batchRun ? 'Génération…' : '▶▶ Tout générer'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !kept.length, title: 'Toute la capsule en un seul fichier WAV', onclick: toggleExportWav }, '⤓ WAV'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !kept.length, title: 'Télécharger les prises retenues séparément (ZIP, pour remonter)', onclick: () => exportZip(kept.map((t) => t.id)) }, '⤓ ZIP'),
      h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.apiOpen), onclick: () => toggleApi() }, '‹/› Voir l’API')));
}

// Zone de panneaux sous les onglets : un clic sur le même bouton ferme, un autre bouton remplace
function togglePanel(zone, name) {
  if (zone.firstChild && zone.dataset.panel === name) { fill(zone); return false; }
  zone.dataset.panel = name;
  return true;
}

function toggleNewSegment() {
  const zone = $('#new-seg-zone');
  if (!togglePanel(zone, 'segment')) return;
  const title = h('input', { type: 'text', id: 'ns-title', maxlength: '120', placeholder: 'ex. La solution' });
  const text = h('textarea', { id: 'ns-text', rows: '3', placeholder: 'Ce que la voix va dire' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  fill(zone, h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    if (!text.value.trim()) { err.textContent = 'Le texte est requis.'; return; }
    try {
      const seg = await api('POST', `/api/v1/projects/${S.projectId}/segments`, { title: title.value, spokenText: text.value, speaker: isDialogue() ? nextSpeaker() : 'A' });
      await loadProject();
      selectSegment(seg.id);
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'label' }, 'Nouveau segment'),
  h('label', { for: 'ns-title' }, 'Titre'), title,
  h('label', { for: 'ns-text' }, 'Texte'), text, err,
  h('div', { class: 'row' },
    h('button', { class: 'btn primary', type: 'submit' }, 'Créer le segment'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => fill(zone) }, 'Annuler'))));
  text.focus();
}

// Découpe d'un script : un segment par paragraphe (ligne vide entre deux paragraphes).
// Un paragraphe trop long est coupé entre deux phrases, sous la limite d'octets.
function splitScript(text, maxBytes) {
  const parts = [];
  for (const para of text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (utf8Bytes(para) <= maxBytes) { parts.push(para); continue; }
    let chunk = '';
    for (const sentence of para.split(/(?<=[.!?…])\s+/)) {
      const next = chunk ? `${chunk} ${sentence}` : sentence;
      if (chunk && utf8Bytes(next) > maxBytes) { parts.push(chunk); chunk = sentence; } else chunk = next;
    }
    if (chunk) parts.push(chunk);
  }
  return parts;
}

// Titre court : premiers mots du segment, sans balises
const autoTitle = (text) => {
  const words = text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 50 ? `${words.slice(0, 50)}…` : words;
};

// Script avec intervenants : « ALEX: texte » en tête de paragraphe (nom en majuscules).
// Renvoie les segments { name, text } et la liste des noms rencontrés, dans l'ordre.
function parseScript(text, maxBytes) {
  const parts = [];
  const names = [];
  for (const para of text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    const m = para.match(/^([A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ0-9' -]{0,29}?)\s*:\s*(\S[\s\S]*)$/);
    const name = m ? m[1].trim() : null;
    if (name && !names.includes(name)) names.push(name);
    for (const chunk of splitScript(m ? m[2] : para, maxBytes)) parts.push({ name, text: chunk });
  }
  return { parts, names };
}

function toggleImport() {
  const zone = $('#new-seg-zone');
  if (!togglePanel(zone, 'import')) return;
  // Marge pour le ton de départ ajouté devant le texte
  const maxBytes = S.caps.limits.maxBytesPerSegment - 300;
  const text = h('textarea', { id: 'imp-text', rows: '10', placeholder: 'Collez votre script ici. Laissez une ligne vide entre les paragraphes : chaque paragraphe devient un segment.\n\nDialogue : commencez chaque réplique par le nom en majuscules.\nALEX: Bonjour !\n\nSAM: Salut Alex.' });
  const info = h('p', { class: 'muted small', role: 'status' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Créer les segments');
  const refresh = () => {
    const { parts, names } = parseScript(text.value, maxBytes);
    const sec = Math.round(parts.map((p) => p.text).join(' ').length / 15);
    const who = names.length === 2 ? ` · dialogue : ${names[0]} → A, ${names[1]} → B`
      : names.length > 2 ? ` · ${names.length} intervenants détectés (${names.join(', ')}) : 2 maximum`
        : isDialogue() && parts.length ? ' · répliques alternées A, B, A…' : '';
    info.textContent = parts.length ? `${parts.length} segment${parts.length > 1 ? 's' : ''} · ≈ ${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} de parole${who}` : '';
    submit.disabled = !parts.length || names.length > 2;
  };
  text.addEventListener('input', refresh);
  // Lecture d'un fichier texte ; en Markdown, les lignes de titre (#) sont retirées
  const loadFile = async (file) => {
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) { err.textContent = 'Fichier .txt ou .md attendu.'; return; }
    let content = await file.text();
    if (/\.md$/i.test(file.name)) content = content.replace(/^#{1,6}\s.*$/gm, '');
    text.value = content;
    err.textContent = '';
    refresh();
  };
  const fileIn = h('input', { type: 'file', id: 'imp-file', accept: '.txt,.md,text/plain,text/markdown' });
  fileIn.addEventListener('change', () => loadFile(fileIn.files[0]));
  text.addEventListener('dragover', (e) => e.preventDefault());
  text.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
  fill(zone, h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const { parts, names } = parseScript(text.value, maxBytes);
    if (!parts.length) { err.textContent = 'Le script est vide.'; return; }
    if (names.length > 2) { err.textContent = 'Deux intervenants maximum.'; return; }
    submit.disabled = true;
    let firstId = null;
    try {
      // Deux noms détectés : le projet passe en dialogue, noms repris (voix conservées)
      if (names.length === 2) {
        const p = S.project;
        S.project = await api('POST', `/api/v1/projects/${p.id}/cast`, {
          mode: 'dialogue', voices: { A: p.voices.A ?? S.voiceId, B: p.voices.B }, names: { A: names[0], B: names[1] }
        });
      }
      const dialogue = isDialogue();
      let alt = nextSpeaker();
      // Création une par une, dans l'ordre du script
      for (const [i, part] of parts.entries()) {
        submit.textContent = `Création ${i + 1} / ${parts.length}…`;
        // Intervenant : par son nom s'il est indiqué, sinon en alternance
        let speaker = 'A';
        if (dialogue) {
          speaker = part.name && names.length === 2 ? (part.name === names[0] ? 'A' : 'B') : alt;
          alt = speaker === 'A' ? 'B' : 'A';
        }
        // Balise en tête de paragraphe → ton de départ du segment (texte envoyé identique)
        const lead = part.text.match(/^(\[[^\]]+\])\s*([\s\S]+)$/);
        const seg = await api('POST', `/api/v1/projects/${S.projectId}/segments`, {
          title: autoTitle(part.text), spokenText: lead ? lead[2] : part.text, instruction: lead ? lead[1] : '', speaker
        });
        firstId ??= seg.id;
      }
      toast(`${parts.length} segment${parts.length > 1 ? 's' : ''} créé${parts.length > 1 ? 's' : ''}.`);
    } catch (ex) {
      err.textContent = `${ex.message} Les segments déjà créés sont conservés.`;
      submit.textContent = 'Créer les segments';
    }
    await loadProject();
    if (firstId) selectSegment(firstId);
  } },
  h('div', { class: 'label' }, 'Importer un script'),
  h('label', { for: 'imp-file' }, 'Depuis un fichier (.txt ou .md)'), fileIn,
  h('label', { for: 'imp-text', class: 'mt-12' }, 'Ou collez le script (vous pouvez aussi y déposer un fichier)'), text, info,
  h('p', { class: 'muted small' }, 'Les balises entre crochets ([laughing], [break]…) sont conservées. Deux noms en majuscules (ALEX: / SAM:) font passer le projet en dialogue.'),
  err,
  h('div', { class: 'row' }, submit,
    h('button', { class: 'btn ghost', type: 'button', onclick: () => fill(zone) }, 'Annuler'))));
  text.focus();
}

function archiveButton(segmentId) {
  const btn = h('button', { class: 'btn ghost small danger', type: 'button', title: 'Archiver ce segment' }, 'Archiver');
  let armed = false;
  btn.addEventListener('click', async () => {
    if (!armed) { armed = true; btn.textContent = 'Confirmer ?'; setTimeout(() => { armed = false; btn.textContent = 'Archiver'; }, 4000); return; }
    S.project = await api('POST', `/api/v1/segments/${segmentId}/archive`);
    S.segmentId = S.project.segments[0]?.id ?? null;
    S.draft = null;
    renderStudio();
  });
  return btn;
}

async function moveSegment(id, direction) {
  S.project = await api('POST', `/api/v1/segments/${id}/move`, { direction });
  renderTabs();
  renderEditor();
}

async function selectSegment(id) {
  if (S.draft && isDirty()) await saveDraft().catch((e) => toast(e.message, 'error'));
  abStop();
  S.segmentId = id;
  S.draft = null;
  S.ab = { A: null, B: null };
  S.compare.clear();
  S.confirmBatch = false;
  S.customOpen = false;
  S.panelJobId = null;
  S.showOverview = false;
  renderStudio();
}

// ---------- Génération en chaîne de toute la capsule ----------
// Segments sans prise sur la version actuelle de leur texte
// Dialogue : voix A/B du projet ; monologue : voix choisie dans l'éditeur
const isDialogue = () => S.project?.mode === 'dialogue';
const speakerName = (k) => S.project?.names?.[k] || k;
const voiceIdFor = (seg) => (isDialogue() ? S.project.voices?.[seg?.speaker ?? 'A'] ?? null : S.voiceId);
// Intervenant d'un nouveau segment : l'inverse du dernier, pour alterner naturellement
const nextSpeaker = () => (S.project?.segments.at(-1)?.speaker === 'A' ? 'B' : 'A');

// À (re)générer : pas de prise sur le texte actuel avec la voix actuelle du segment
// (un changement de voix A/B ou de voix du monologue rend donc les segments concernés à refaire)
const missingSegments = () => S.project.segments.filter((s) => !s.takes.some((t) => t.revisionId === s.currentRevisionId && t.voiceId === voiceIdFor(s)));
// Prise retenue faite avec une autre voix que celle prévue aujourd'hui
const chosenWithOtherVoice = (s) => {
  const t = s.takes.find((x) => x.id === s.chosenTakeId);
  return Boolean(t && voiceIdFor(s) && t.voiceId !== voiceIdFor(s));
};

function toggleGenerateAll(keepOpen = false) {
  const zone = $('#new-seg-zone');
  if (S.batchRun || (!keepOpen && !togglePanel(zone, 'generate'))) return;
  // « Tout régénérer » : chaque segment, même déjà généré (ex. après un changement de réglages audio)
  const segs = S.genAllForce ? S.project.segments : missingSegments();
  const model = modelInfo(S.modelKey);
  // Voix utilisées : une en monologue, celles des intervenants concernés en dialogue
  const used = [...new Set(segs.map(voiceIdFor))];
  const v = used.every(Boolean) ? used.map((id) => voice(id)).filter(Boolean) : null;
  const voiceText = v?.length ? v.map((x) => x.name).join(' + ') : '?';
  const total = segs.reduce((sum, s) => sum + (estimateUsd(utf8Bytes(buildFinalText(s.revision.spokenText, s.revision.instruction)), model?.pricePerMillionBytes) ?? NaN), 0);
  const cost = Number.isNaN(total) ? 'coût inconnu' : total === 0 ? 'gratuit' : `≈ ${fmtUsd(total)}`;
  const force = h('input', { type: 'checkbox', id: 'gen-force', checked: Boolean(S.genAllForce) });
  force.addEventListener('change', () => { S.genAllForce = force.checked; toggleGenerateAll(true); });
  fill(zone, h('div', { class: 'card' },
    h('div', { class: 'label' }, S.genAllForce ? 'Régénérer toute la capsule' : 'Générer toute la capsule'),
    segs.length
      ? h('p', {}, `${segs.length} segment${segs.length > 1 ? 's' : ''} ${S.genAllForce ? 'à régénérer' : 'sans prise avec leur texte et leur voix actuels'}, dans l’ordre · voix ${voiceText} · ${model?.label ?? '?'} · ${audioOptionsLabel(S.audio)} · ${segs.length} appel${segs.length > 1 ? 's' : ''}, ${cost}.`)
      : h('p', {}, 'Tous les segments ont déjà une prise avec leur texte et leur voix actuels.'),
    !v?.length && segs.length ? h('p', { class: 'blocked' }, 'Une voix manque : choisissez les voix A et B en haut du studio.') : null,
    h('label', { class: 'check', for: 'gen-force' }, force, 'Tout régénérer, même les segments déjà faits (après un changement de réglages audio, par exemple)'),
    h('p', { class: 'muted small' }, S.genAllForce ? 'Chaque segment garde son ton de départ. Les nouvelles prises deviennent les prises retenues ; les anciennes restent disponibles.' : 'Chaque segment garde son ton de départ. La nouvelle prise devient la prise retenue si le segment n’en avait pas, ou si la sienne a été faite avec une autre voix. Les anciennes prises restent disponibles.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', disabled: !segs.length || !v?.length || !model?.allowed, onclick: () => generateAll(segs.map((s) => s.id)) }, 'Lancer la génération'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => fill(zone) }, 'Annuler'))));
}

// Attente de la fin d'une génération (le serveur traite la file)
async function waitJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const job = await api('GET', `/api/v1/generations/${id}`);
    if (job.state !== 'queued' && job.state !== 'running') return job;
  }
}

async function generateAll(segmentIds) {
  const zone = $('#new-seg-zone');
  const status = h('p', { role: 'status' });
  const stop = h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.batchRun.stop = true; stop.disabled = true; stop.textContent = 'Arrêt après ce segment…'; } }, 'Arrêter');
  fill(zone, h('div', { class: 'card' }, h('div', { class: 'label' }, 'Génération de la capsule'), status, h('div', { class: 'row' }, stop)));
  S.batchRun = { stop: false };
  let done = 0;
  let message = '';
  try {
    await loadCaps();
    if (S.caps.serverOutdated) throw new Error('Serveur à relancer avant de générer : relancez lancer-capsule-studio.bat.');
    if (S.draft && isDirty()) await saveDraft();
    for (const [i, id] of segmentIds.entries()) {
      if (S.batchRun.stop) { message = `Arrêté : ${done} / ${segmentIds.length} segments générés.`; break; }
      const seg = S.project.segments.find((s) => s.id === id);
      if (!seg) continue;
      status.textContent = `Segment ${i + 1} / ${segmentIds.length} : ${seg.title || 'sans titre'}…`;
      // Sans "instruction" : le serveur utilise le ton de départ enregistré du segment
      const plan = await api('POST', '/api/v1/generation-plans', {
        segmentId: seg.id, revisionId: seg.currentRevisionId, voiceId: voiceIdFor(seg), modelKey: S.modelKey, audio: S.audio
      });
      await api('POST', `/api/v1/generation-plans/${plan.id}/approve`);
      const started = await api('POST', '/api/v1/generations', { planId: plan.id }, { 'Idempotency-Key': crypto.randomUUID() });
      const job = await waitJob(started.id);
      if (job.state !== 'succeeded') throw new Error(`Segment ${i + 1} : ${job.error?.message || `génération ${job.state}`}. Les prises déjà générées sont conservées.`);
      if (job.takeId && (S.genAllForce || !seg.chosenTakeId || chosenWithOtherVoice(seg))) await api('POST', `/api/v1/segments/${seg.id}/choose`, { takeId: job.takeId });
      done++;
      await loadProject();
      renderTabs();
      renderTakes();
    }
    if (!message) message = `Capsule générée : ${done} segment${done > 1 ? 's' : ''}.`;
    toast(message);
  } catch (e) {
    message = e.message;
    toast(e.message, 'error');
  } finally {
    S.batchRun = null;
    await loadProject().catch(() => {});
    renderStudio();
    const z = $('#new-seg-zone');
    if (z) fill(z, h('div', { class: 'card' }, h('p', { role: 'status' }, message), h('button', { class: 'btn ghost small', type: 'button', onclick: () => fill(z) }, 'Fermer')));
  }
}

// ---------- Export de la capsule en un seul WAV ----------
function toggleExportWav() {
  const zone = $('#new-seg-zone');
  if (!togglePanel(zone, 'wav')) return;
  const kept = chosenTakes();
  const notWav = kept.filter((t) => (t.audioOptions?.format ?? 'mp3') !== 'wav').length;
  const gap = h('select', { id: 'wav-gap' }, [0, 250, 500, 1000, 2000].map((ms) => h('option', { value: String(ms) }, ms ? `${String(ms / 1000).replace('.', ',')} s` : 'Aucun')));
  const missing = S.project.segments.length - kept.length;
  fill(zone, h('div', { class: 'card' },
    h('div', { class: 'label' }, 'Exporter la capsule en un seul WAV'),
    h('p', {}, `${kept.length} prise${kept.length > 1 ? 's' : ''} retenue${kept.length > 1 ? 's' : ''}, mises bout à bout dans l’ordre des segments.`),
    missing ? h('p', { class: 'blocked' }, `${missing} segment${missing > 1 ? 's' : ''} sans prise retenue : ignoré${missing > 1 ? 's' : ''} dans l’export.`) : null,
    notWav ? h('p', { class: 'blocked' }, `${notWav} prise${notWav > 1 ? 's' : ''} en MP3 : l’assemblage exige du WAV, régénérez-les en WAV.`) : null,
    h('label', { for: 'wav-gap' }, 'Silence entre les segments'), gap,
    h('div', { class: 'row mt-12' },
      h('button', { class: 'btn primary', type: 'button', disabled: !kept.length || notWav > 0, onclick: () => exportWav(kept.map((t) => t.id), Number(gap.value)) }, '⤓ Télécharger le WAV'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => fill(zone) }, 'Annuler'))));
}

async function exportWav(takeIds, gapMs) {
  try {
    const res = await fetch('/api/v1/exports/wav', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Capsule-CSRF': '1' }, body: JSON.stringify({ takeIds, gapMs }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Export impossible.');
    const url = URL.createObjectURL(await res.blob());
    // Nom explicite et daté : projet + date
    const name = (S.project.name || 'capsule').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'capsule';
    const a = h('a', { href: url, download: `${name}-${new Date().toISOString().slice(0, 10)}.wav` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Éditeur ----------
function ensureDraft() {
  const seg = segment();
  if (!seg) return null;
  if (!S.draft || S.draft.segmentId !== seg.id) {
    S.draft = { segmentId: seg.id, title: seg.title || '', spokenText: seg.revision.spokenText, instruction: seg.revision.instruction || '' };
  }
  return S.draft;
}

function isDirty() {
  const seg = segment();
  const d = S.draft;
  return Boolean(seg && d && (d.spokenText.trim() !== seg.revision.spokenText || d.instruction.trim() !== (seg.revision.instruction || '') || d.title.trim() !== (seg.title || '')));
}

async function saveDraft() {
  const seg = segment();
  if (!seg || !isDirty()) return seg;
  const updated = await api('POST', `/api/v1/segments/${seg.id}/revisions`, {
    baseRevisionId: seg.currentRevisionId, title: S.draft.title, spokenText: S.draft.spokenText, instruction: S.draft.instruction
  });
  const idx = S.project.segments.findIndex((s) => s.id === seg.id);
  S.project.segments[idx] = updated;
  return updated;
}

function renderEditor() {
  const card = $('#editor-card');
  if (!card) return;
  const seg = segment();
  if (!seg) {
    fill(card, h('div', { class: 'label' }, 'Aucun segment'), h('p', { class: 'muted' }, 'Ajoutez un segment avec « + Segment ».'));
    return;
  }
  const d = ensureDraft();
  const idx = S.project.segments.findIndex((s) => s.id === seg.id);
  const isPreset = INTENTS.some((i) => i.tag === d.instruction.trim());

  const titleIn = h('input', { type: 'text', class: 'title-input', id: 'ed-title', maxlength: '120', value: d.title, placeholder: 'Titre du segment', 'aria-label': 'Titre du segment' });
  const tagEl = h('span', { class: 'script-tag', id: 'script-tag', 'aria-hidden': 'true' }, d.instruction.trim());
  const textIn = h('textarea', { class: 'script-input', id: 'ed-text', rows: '1', 'aria-label': 'Ce que la voix va dire', 'aria-describedby': 'text-help', placeholder: 'Tapez ici ce que la voix va dire' });
  textIn.value = d.spokenText;
  textIn.classList.toggle('long', d.spokenText.length > 220);
  const instrIn = h('input', { type: 'text', id: 'ed-instr', maxlength: '300', value: d.instruction.replace(/^\[|\]$/g, ''), placeholder: 'ex. tired but amused' });
  const autosize = () => { textIn.style.height = 'auto'; textIn.style.height = `${textIn.scrollHeight}px`; };
  const onInput = () => {
    d.title = titleIn.value;
    d.spokenText = textIn.value;
    d.instruction = normalizeInstruction(instrIn.value);
    tagEl.textContent = d.instruction.trim();
    textIn.classList.toggle('long', d.spokenText.length > 220);
    S.confirmBatch = false;
    autosize();
    updatePreview();
  };
  [titleIn, textIn, instrIn].forEach((el) => {
    el.addEventListener('input', onInput);
    el.addEventListener('blur', () => saveDraft().then(() => { renderTabs(); updatePreview(); }).catch((e) => toast(e.message, 'error')));
  });

  const insertTag = (tag) => {
    const start = textIn.selectionStart ?? textIn.value.length;
    const end = textIn.selectionEnd ?? start;
    const before = textIn.value.slice(0, start);
    const after = textIn.value.slice(end);
    const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${tag}${after && !/^\s/.test(after) ? ' ' : ''}`;
    textIn.value = before + piece + after;
    textIn.focus();
    textIn.selectionStart = textIn.selectionEnd = before.length + piece.length;
    onInput();
    saveDraft().then(() => renderTabs()).catch((e) => toast(e.message, 'error'));
  };
  const palette = h('div', { class: 'compare-panel tag-palette' },
    h('p', { class: 'small muted' }, 'Placez le curseur dans le texte puis cliquez sur une balise : elle s’insère à cet endroit et agit sur ce qui suit. Les balises restent en anglais, c’est la langue documentée par Fish Audio. Groupe « Libres » : descriptions acceptées mais non documentées, à valider à l’écoute.'),
    TAG_GROUPS.map((g) => h('div', { class: 'tag-group' },
      h('small', {}, g.label),
      h('div', { class: 'tag-list' }, g.tags.map(([fr, tag]) => h('button', {
        type: 'button', class: 'tag-btn', title: g.free ? `${tag} · description libre, rendu non garanti par Fish Audio` : tag,
        // Empêche le champ texte de perdre le curseur au clic
        onmousedown: (e) => e.preventDefault(), onclick: () => insertTag(tag)
      }, fr, h('code', {}, tag)))))));

  const intents = h('div', { class: 'intents', role: 'group', 'aria-label': 'Intention' },
    INTENTS.map((it) => h('button', {
      type: 'button', class: 'intent', 'aria-pressed': String(d.instruction.trim() === it.tag && !S.customOpen),
      onclick: () => { instrIn.value = it.tag; S.customOpen = false; onInput(); renderEditor(); }
    }, h('span', { class: 'ico', 'aria-hidden': 'true' }, INTENT_ICONS[it.id]), it.label)),
    h('button', {
      type: 'button', class: 'intent custom', 'aria-pressed': String(!isPreset || S.customOpen),
      // Repart d'un champ vide : la balise prédéfinie n'est pas recopiée dedans
      onclick: () => { if (isPreset) d.instruction = ''; S.customOpen = true; renderEditor(); $('#ed-instr')?.focus(); }
    }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '✎'), 'Personnalisée'));

  const voices = readyVoices();
  const voiceSel = h('select', { id: 'ed-voice', disabled: !voices.length },
    voices.length ? voices.map((v) => h('option', { value: v.id, selected: v.id === S.voiceId }, v.name)) : [h('option', {}, 'Aucune voix prête')]);
  voiceSel.addEventListener('change', () => { S.voiceId = voiceSel.value; store.set('cs.voice', S.voiceId); updatePreview(); });
  const modelSel = h('select', { id: 'ed-model' }, S.caps.models.map((m) =>
    h('option', { value: m.key, selected: m.key === S.modelKey }, `${m.label}${m.allowed ? '' : ' (bloqué)'}`)));
  modelSel.addEventListener('change', () => { S.modelKey = modelSel.value; store.set('cs.model', S.modelKey); S.confirmBatch = false; updatePreview(); });

  fill(card,
    h('div', { class: 'head' },
      h('div', { class: 'label' }, 'Ce que la voix va dire'),
      titleIn,
      h('div', { class: 'seg-tools' },
        h('button', { class: 'btn ghost small icon-btn', type: 'button', disabled: idx === 0, 'aria-label': 'Déplacer le segment à gauche', title: 'Déplacer à gauche', onclick: () => moveSegment(seg.id, 'up') }, '←'),
        h('button', { class: 'btn ghost small icon-btn', type: 'button', disabled: idx === S.project.segments.length - 1, 'aria-label': 'Déplacer le segment à droite', title: 'Déplacer à droite', onclick: () => moveSegment(seg.id, 'down') }, '→'),
        archiveButton(seg.id))),
    h('div', { class: 'script-line' }, tagEl, textIn),
    h('p', { class: 'muted small text-help', id: 'text-help' },
      h('span', {}, '✎ Cliquez sur le texte pour le modifier · enregistré automatiquement'),
      h('span', { id: 'text-count' })),
    h('div', { class: 'compare-link' },
      h('button', { type: 'button', class: 'btn small ghost', 'aria-expanded': String(S.showTags), onclick: () => { S.showTags = !S.showTags; renderEditor(); } },
        S.showTags ? '▾ Insérer une balise dans le texte (rire, pause, émotion…)' : '▸ Insérer une balise dans le texte (rire, pause, émotion…)')),
    S.showTags ? palette : null,
    seg.revision.author === 'agent' ? h('p', { class: 'muted small mt-8' }, 'Texte écrit par l’agent.') : null,
    h('div', { class: 'label mt-12' }, 'Ton de départ'),
    intents,
    h('p', { class: 'muted small mt-8' }, 'Placé au début du texte, il donne le ton général. Pour changer de ton en cours de route, insérez une balise dans le texte.'),
    (!isPreset || S.customOpen) ? h('div', { class: 'custom-input' },
      h('label', { for: 'ed-instr' }, 'Décrivez le ton en quelques mots, de préférence en anglais (les crochets sont ajoutés automatiquement)'),
      h('div', { class: 'bracket-input' }, h('span', { 'aria-hidden': 'true' }, '['), instrIn, h('span', { 'aria-hidden': 'true' }, ']')),
      h('p', { class: 'muted small mt-8' }, 'Le français n’est pas garanti : Fish Audio ne documente que des descriptions en anglais.')) : null,
    h('div', { class: 'gen-row' },
      isDialogue()
        ? h('div', { class: 'field' }, h('small', {}, 'Voix'), h('div', { class: 'cast-voice' }, h('span', { class: `spk spk-${seg.speaker}` }, seg.speaker), `${speakerName(seg.speaker)} · ${voice(voiceIdFor(seg))?.name ?? 'voix à choisir en haut'}`))
        : h('div', { class: 'field' }, h('small', {}, 'Voix'), voiceSel),
      h('div', { class: 'field' }, h('small', {}, 'Modèle'), modelSel),
      h('button', { class: 'go', type: 'button', id: 'generate-btn', onclick: () => generate([S.draft.instruction]) },
        'Générer la prise', h('span', { class: 'sub', id: 'generate-sub' }))),
    h('p', { class: 'blocked', id: 'blocked', role: 'status' }),
    audioSettings(),
    voices.length ? null : h('p', { class: 'small' }, h('a', { href: '#/voix' }, 'Ajouter ou cloner une voix')),
    h('div', { class: 'compare-link' },
      h('button', { type: 'button', class: 'btn small ghost', 'aria-expanded': String(S.showCompare), onclick: () => { S.showCompare = !S.showCompare; S.confirmBatch = false; renderEditor(); } },
        S.showCompare ? '▾ Comparer plusieurs intentions' : '▸ Comparer plusieurs intentions')),
    S.showCompare ? h('div', { class: 'compare-panel' },
      h('p', { class: 'small muted' }, `Mêmes mots, jusqu’à ${S.caps.limits.maxTakesPerBatch} intentions : une prise par intention.`),
      h('div', { class: 'intents', role: 'group', 'aria-label': 'Intentions à comparer' }, INTENTS.map((it) =>
        h('button', { type: 'button', class: 'intent', 'aria-pressed': String(S.compare.has(it.tag)), onclick: (e) => {
          if (S.compare.has(it.tag)) S.compare.delete(it.tag);
          else if (S.compare.size < S.caps.limits.maxTakesPerBatch) S.compare.add(it.tag);
          else { toast(`${S.caps.limits.maxTakesPerBatch} intentions maximum par action.`); return; }
          e.currentTarget.setAttribute('aria-pressed', String(S.compare.has(it.tag)));
          S.confirmBatch = false;
          updatePreview();
        } }, h('span', { class: 'ico', 'aria-hidden': 'true' }, INTENT_ICONS[it.id]), it.label))),
      h('div', { id: 'batch-zone', class: 'mt-12' })) : null);
  requestAnimationFrame(autosize);
  updatePreview();
}

// Réglages audio : normalisation du volume par Fish Audio et ajustement en dB
function audioSettings() {
  const label = audioOptionsLabel(S.audio);
  const norm = h('input', { type: 'checkbox', id: 'au-norm', checked: S.audio.normalizeLoudness });
  const vol = h('select', { id: 'au-vol' }, VOLUME_STEPS.map((db) => h('option', { value: String(db), selected: db === S.audio.volumeDb }, db === 0 ? '0 dB (inchangé)' : `${db} dB`)));
  const fmt = h('select', { id: 'au-fmt' }, Object.entries(FORMATS).map(([k, v]) => h('option', { value: k, selected: k === S.audio.format }, k === 'wav' ? `${v.label} (recommandé pour le montage)` : v.label)));
  const save = () => {
    S.audio = cleanAudioOptions({ normalizeLoudness: norm.checked, volumeDb: Number(vol.value), format: fmt.value, sampleRate: SAMPLE_RATES[0] });
    store.set('cs.audio', JSON.stringify(S.audio));
    renderEditor();
  };
  [norm, vol, fmt].forEach((el) => el.addEventListener('change', save));
  return h('div', { class: 'audio-settings' },
    h('button', { type: 'button', class: 'btn small ghost', 'aria-expanded': String(S.showAudio), onclick: () => { S.showAudio = !S.showAudio; renderEditor(); } },
      `${S.showAudio ? '▾' : '▸'} Réglages audio${label ? ` : ${label}` : ''}`),
    S.showAudio ? h('div', { class: 'compare-panel' },
      h('label', { class: 'check', for: 'au-norm' }, norm, 'Normalisation du volume par Fish Audio (activée par défaut chez Fish Audio)'),
      h('div', { class: 'grid-2' },
        h('div', {}, h('label', { for: 'au-fmt' }, 'Format du fichier'), fmt),
        h('div', {}, h('label', {}, 'Fréquence d’échantillonnage'), h('p', { class: 'muted small' }, '44,1 kHz (maximum proposé par Fish Audio, à convertir en 48 kHz au montage si besoin)'))),
      h('label', { for: 'au-vol' }, 'Ajustement du volume'), vol,
      h('p', { class: 'muted small mt-8' }, 'Envoyés dans la requête (prosody). Chaque prise garde ses réglages, visibles dans la liste des prises.')) : null);
}

// Texte final avec indication mise en évidence (utilisé aussi par les propositions)
function finalTextNode(text, instruction) {
  const tag = (instruction || '').trim();
  return tag && text.startsWith(tag) ? [h('span', { class: 'tag' }, tag), text.slice(tag.length)] : [text];
}

function updatePreview() {
  const seg = segment();
  const d = S.draft;
  if (!seg || !d) return;
  const finalText = buildFinalText(d.spokenText, d.instruction);
  const bytes = utf8Bytes(finalText);
  const model = modelInfo(S.modelKey);
  const v = voice(voiceIdFor(seg));
  const limit = S.caps.limits.maxBytesPerSegment;

  let blocked = null;
  if (S.caps.serverOutdated) blocked = 'Le serveur tourne sur une ancienne version : fermez la fenêtre noire et relancez lancer-capsule-studio.bat.';
  else if (!S.caps.fishConfigured) blocked = 'Clé Fish Audio absente : voir Réglages.';
  else if (!model?.allowed) blocked = model?.reason || 'Modèle indisponible.';
  else if (!v) blocked = isDialogue() ? `Choisissez la voix de ${speakerName(seg.speaker)} (${seg.speaker}) en haut du studio.` : 'Aucune voix prête : ajoutez ou clonez une voix.';
  else if (!d.spokenText.trim()) blocked = 'Le texte est vide.';
  else if (bytes > limit) blocked = `Texte trop long (${bytes} / ${limit} octets).`;
  const nearLimit = !blocked && bytes > limit * 0.8 ? `Texte long : ${bytes} / ${limit} octets.` : null;

  const usd = estimateUsd(bytes, model?.pricePerMillionBytes);
  const sub = usd === null ? 'coût inconnu' : model?.paid ? `≈ ${fmtUsd(usd)}` : 'gratuit';
  const btn = $('#generate-btn');
  if (btn) btn.disabled = Boolean(blocked);
  const subEl = $('#generate-sub');
  if (subEl) subEl.textContent = sub;
  const count = $('#text-count');
  if (count) {
    const sec = Math.round(d.spokenText.trim().length / 15);
    count.textContent = `${bytes} / ${limit} octets · ≈ ${sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')}`} de parole`;
  }
  const b = $('#blocked');
  if (b) { b.textContent = blocked || nearLimit || ''; b.hidden = !(blocked || nearLimit); }

  // Génération groupée : requêtes visibles avant confirmation
  const zone = $('#batch-zone');
  if (zone) {
    const tags = [...S.compare];
    if (!tags.length) fill(zone);
    else {
      const texts = tags.map((t) => buildFinalText(d.spokenText, t));
      const total = texts.reduce((sum, t) => sum + (estimateUsd(utf8Bytes(t), model?.pricePerMillionBytes) ?? NaN), 0);
      const tooLong = texts.some((t) => utf8Bytes(t) > limit);
      fill(zone, S.confirmBatch
        ? h('div', { class: 'info-box' },
          h('p', {}, h('strong', {}, `${tags.length} requêtes vont partir chez Fish Audio (${model?.providerId}) :`)),
          h('ol', {}, texts.map((t) => h('li', { class: 'serif' }, ...finalTextNode(t, tags[texts.indexOf(t)])))),
          h('p', {}, `${tags.length} appels · ${Number.isNaN(total) ? 'coût inconnu' : total === 0 ? 'gratuit (offre S2.1 Pro Free)' : fmtUsd(total)}`),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', onclick: () => { S.confirmBatch = false; generate(tags); } }, 'Confirmer et générer'),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.confirmBatch = false; updatePreview(); } }, 'Annuler')))
        : h('button', { class: 'btn primary', type: 'button', disabled: Boolean(blocked) || tooLong, onclick: () => { S.confirmBatch = true; updatePreview(); } },
          `Préparer ${tags.length} prise${tags.length > 1 ? 's' : ''} : ${tags.map(intentLabel).join(', ')}`));
    }
  }
  if (S.apiOpen && !S.panelJobId) renderApiPanel();
}

// ---------- Génération (plan → approbation → exécution) ----------
async function generate(instructions) {
  const btn = $('#generate-btn');
  if (btn) btn.disabled = true;
  try {
    // Le serveur a-t-il été relancé depuis la dernière mise à jour ?
    await loadCaps();
    if (S.caps.serverOutdated) { toast('Serveur à relancer avant de générer : fermez la fenêtre noire et relancez lancer-capsule-studio.bat.', 'error'); return; }
    const seg = await saveDraft();
    const ids = [];
    for (const instruction of instructions) {
      const plan = await api('POST', '/api/v1/generation-plans', {
        segmentId: seg.id, revisionId: seg.currentRevisionId, instruction, voiceId: voiceIdFor(seg), modelKey: S.modelKey, audio: S.audio
      });
      await api('POST', `/api/v1/generation-plans/${plan.id}/approve`);
      const job = await api('POST', '/api/v1/generations', { planId: plan.id }, { 'Idempotency-Key': crypto.randomUUID() });
      S.jobs.set(job.id, job);
      ids.push(job.id);
    }
    S.panelJobId = ids[0];
    renderTabs();
    renderTakes();
    renderApiPanel();
    pollJobs();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    updatePreview();
  }
}

let polling = false;
async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const active = [...S.jobs.values()].filter((j) => j.state === 'queued' || j.state === 'running');
      if (!active.length) break;
      await new Promise((r) => setTimeout(r, 400));
      let finished = false;
      for (const j of active) {
        const fresh = await api('GET', `/api/v1/generations/${j.id}`);
        S.jobs.set(j.id, fresh);
        if (fresh.state !== 'queued' && fresh.state !== 'running') {
          finished = true;
          if (fresh.state === 'succeeded') toast('Prise prête : audio reçu de Fish Audio.');
          else toast(fresh.error?.message || `Génération ${fresh.state}.`, 'error');
        }
      }
      if (finished) {
        await loadProject();
        renderTabs();
      }
      renderTakes();
      renderApiPanel();
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    polling = false;
  }
}

// ---------- Lecteurs audio avec forme d'onde réelle ----------
const players = new Map();
let currentAudio = null;
let audioCtx = null;

function claimAudio(audio) {
  if (currentAudio && currentAudio !== audio) currentAudio.pause();
  currentAudio = audio;
}

function getPlayer(t) {
  let p = players.get(t.id);
  if (p) return p;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = t.audioUrl;
  p = { id: t.id, audio, canvas: null, btn: null, peaks: null };
  audio.addEventListener('play', () => { claimAudio(audio); updatePlayBtn(p); });
  audio.addEventListener('pause', () => updatePlayBtn(p));
  audio.addEventListener('ended', () => { updatePlayBtn(p); drawWave(p); });
  audio.addEventListener('timeupdate', () => drawWave(p));
  players.set(t.id, p);
  loadPeaks(p, t.audioUrl);
  return p;
}

// Crêtes calculées en décodant le vrai fichier MP3 dans le navigateur
async function loadPeaks(p, url) {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    audioCtx ??= new AudioContext();
    const decoded = await audioCtx.decodeAudioData(buf);
    const data = decoded.getChannelData(0);
    const n = 160;
    const step = Math.max(1, Math.floor(data.length / n));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let max = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(data[j]));
      peaks.push(max);
    }
    const top = Math.max(...peaks);
    p.peaks = top > 0 ? peaks.map((x) => x / top) : peaks;
  } catch {
    p.peaks = null; // forme d'onde indisponible : barres neutres
  }
  drawWave(p);
}

function drawWave(p) {
  const c = p.canvas;
  if (!c || !c.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w) c.width = w;
  if (c.height !== hgt) c.height = hgt;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement);
  const off = css.getPropertyValue('--wave').trim();
  const on = css.getPropertyValue('--wave-on').trim();
  const barW = 3 * dpr;
  const gap = 2.5 * dpr;
  const count = Math.floor(w / (barW + gap));
  const progress = p.audio.duration ? p.audio.currentTime / p.audio.duration : 0;
  for (let i = 0; i < count; i++) {
    const peak = p.peaks ? p.peaks[Math.floor((i / count) * p.peaks.length)] : 0.15;
    const bh = Math.max(3 * dpr, peak * hgt * 0.95);
    ctx.fillStyle = i / count < progress ? on : off;
    const x = i * (barW + gap);
    ctx.beginPath();
    ctx.roundRect(x, (hgt - bh) / 2, barW, bh, barW / 2);
    ctx.fill();
  }
}

function updatePlayBtn(p) {
  if (!p.btn) return;
  const playing = !p.audio.paused && !p.audio.ended;
  p.btn.textContent = playing ? '❚❚' : '▶';
  p.btn.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire la prise');
}

function playerControls(t) {
  const p = getPlayer(t);
  p.btn = h('button', { type: 'button', class: 'play', onclick: () => {
    if (p.audio.paused) p.audio.play().catch(() => toast('Lecture impossible.', 'error'));
    else p.audio.pause();
  } });
  p.canvas = h('canvas', { class: 'wave', role: 'img', 'aria-label': 'Forme d’onde : cliquer pour se déplacer dans la prise' });
  p.canvas.addEventListener('click', (e) => {
    const r = p.canvas.getBoundingClientRect();
    if (!p.audio.duration) return;
    p.audio.currentTime = ((e.clientX - r.left) / r.width) * p.audio.duration;
    if (p.audio.paused) p.audio.play().catch(() => {});
  });
  updatePlayBtn(p);
  requestAnimationFrame(() => drawWave(p));
  return p;
}

// ---------- Prises ----------
function renderTakes() {
  const card = $('#takes-card');
  if (!card) return;
  const seg = segment();
  if (S.showOverview && S.project) { renderOverview(card); return; }
  if (!seg) { fill(card); return; }
  const takes = [...seg.takes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const jobs = [...S.jobs.values()].filter((j) => j.segmentId === seg.id && j.state !== 'succeeded');

  const rows = takes.map((t) => {
    const p = playerControls(t);
    const old = t.revisionId !== seg.currentRevisionId;
    // Format réel de la prise (les anciennes prises sans réglages étaient en MP3)
    const dlLabel = `Télécharger le ${(t.audioOptions?.format ?? 'mp3').toUpperCase()}`;
    return h('article', { class: `take ${t.chosen ? 'chosen' : ''}`, 'aria-label': `Prise ${toneLabel(t.finalText)}`, title: toneLabel(t.finalText) },
      p.btn,
      h('div', { class: 'who' },
        h('b', {}, toneLabel(t.finalText)),
        // Voix : nom actuel si elle existe encore, sinon nom enregistré avec la prise
        h('small', {}, [voice(t.voiceId)?.name ?? t.voiceName, fmtSec(t.durationSec), fmtHM(t.createdAt), audioOptionsLabel(t.audioOptions)].filter(Boolean).join(' · ')),
        old ? h('span', { class: 'old', title: t.finalText }, 'Ancienne version du texte') : null),
      p.canvas,
      h('div', { class: 'take-acts' },
        h('button', { type: 'button', class: `keep ${t.chosen ? 'on' : ''}`, disabled: t.chosen, onclick: () => chooseTake(t.id) }, t.chosen ? 'Retenue' : 'Garder'),
        h('button', { type: 'button', class: 'ab-pill', 'aria-pressed': String(S.ab.A === t.id), 'aria-label': 'Placer en A', onclick: () => setAB('A', t.id) }, 'A'),
        h('button', { type: 'button', class: 'ab-pill', 'aria-pressed': String(S.ab.B === t.id), 'aria-label': 'Placer en B', onclick: () => setAB('B', t.id) }, 'B'),
        h('a', { class: 'btn ghost small icon-btn', href: `${t.audioUrl}?download=1`, title: dlLabel, 'aria-label': dlLabel }, '⤓'),
        h('button', { type: 'button', class: 'btn ghost small', title: 'Voir l’API de cette prise', onclick: () => showJob(t.jobId) }, 'API')));
  });

  const pending = jobs.map((j) => {
    const active = j.state === 'queued' || j.state === 'running';
    return h('article', { class: 'take pending' },
      active ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : h('span', { class: 'pill danger' }, '!'),
      h('div', { class: 'who' },
        h('b', {}, active ? `Génération en cours… ${toneLabel(jobText(j))}` : j.state === 'uncertain' ? 'Résultat incertain' : 'Échec'),
        j.error ? h('small', {}, j.error.message, j.state === 'uncertain' ? ' Une nouvelle tentative pourrait être comptée deux fois.' : '') : h('small', {}, phaseLabel(j))),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => showJob(j.id) }, '‹/› API'));
  });

  fill(card,
    h('div', { class: 'takes-head' },
      h('div', { class: 'label' }, takes.length > 1 ? `Prises · ${takes.length}` : 'Prises'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { abStop(); S.showOverview = true; renderTakes(); } }, '☰ Toute la capsule')),
    h('div', { id: 'ab-zone' }),
    rows.length || pending.length ? h('div', { class: 'takes' }, rows, pending) : h('p', { class: 'muted' }, 'Aucune prise pour l’instant : choisissez une intention puis « Générer la prise ».'),
    rows.length ? h('div', { class: 'synth' }, 'Voix synthétique · Fish Audio S2.1 Pro') : null);
  renderAbBar();
}

// Durée lisible : 2 min 32 ou 45 s
const fmtTotal = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')}` : `${Math.round(sec)} s`);

// Vue d'ensemble : chaque segment avec sa prise retenue, son état et la durée totale
function renderOverview(card) {
  const segs = S.project.segments;
  const rows = segs.map((seg, i) => {
    const t = seg.takes.find((x) => x.id === seg.chosenTakeId) ?? null;
    const old = t && t.revisionId !== seg.currentRevisionId;
    const p = t ? playerControls(t) : null;
    const state = !t ? h('span', { class: 'ov-state warn' }, '⚠ aucune prise retenue')
      : old ? h('span', { class: 'ov-state warn', title: 'Le texte a changé depuis cette prise' }, '⚠ ancien texte')
        : chosenWithOtherVoice(seg) ? h('span', { class: 'ov-state warn', title: `Prise faite avec « ${t.voiceName} »` }, '⚠ autre voix')
        : h('span', { class: 'ov-state ok', 'aria-label': 'prise retenue' }, '✓');
    return h('div', { class: `ov-row ${t ? '' : 'empty'}` },
      h('span', { class: 'ov-n' }, String(i + 1)),
      p ? p.btn : h('span', { class: 'ov-noplay', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'ov-title', title: 'Ouvrir ce segment', onclick: () => selectSegment(seg.id) },
        isDialogue() ? h('span', { class: `spk spk-${seg.speaker}`, title: speakerName(seg.speaker) }, seg.speaker) : null, seg.title || `Segment ${i + 1}`),
      h('span', { class: 'ov-meta' }, toneLabel(t ? t.finalText : buildFinalText(seg.revision.spokenText, seg.revision.instruction))),
      h('span', { class: 'ov-meta' }, t ? fmtSec(t.durationSec) : '—'),
      state);
  });
  const kept = chosenTakes();
  const total = kept.reduce((sum, t) => sum + (t.durationSec || 0), 0);
  fill(card,
    h('div', { class: 'takes-head' },
      h('div', { class: 'label' }, `Toute la capsule · ${segs.length} segment${segs.length > 1 ? 's' : ''} · ${fmtTotal(total)} · ${kept.length}/${segs.length} retenu${kept.length > 1 ? 's' : ''}`),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { abStop(); S.showOverview = false; renderTakes(); } }, '← Prises du segment')),
    segs.length ? h('div', { class: 'ov-list' }, rows) : h('p', { class: 'muted' }, 'Aucun segment dans ce projet.'),
    h('div', { class: 'row mt-12' },
      h('button', { type: 'button', class: 'btn small', disabled: !kept.length, onclick: () => { togglePlaylist(kept); renderTakes(); } }, playlist ? '■ Arrêter' : '▶ Écouter tout'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !kept.length, onclick: () => { toggleExportWav(); $('#new-seg-zone')?.scrollIntoView({ behavior: 'smooth' }); } }, '⤓ WAV'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !kept.length, onclick: () => exportZip(kept.map((t) => t.id)) }, '⤓ ZIP')),
    h('p', { class: 'muted small mt-8' }, 'Cliquez sur un titre pour ouvrir le segment.'));
}

function phaseLabel(j) {
  return { queued: 'En file d’attente', sending: 'Envoi à Fish Audio', sent: 'Envoyée, en attente de l’audio', receiving: 'Réception de l’audio', retry_wait: 'Limite de débit : nouvel essai bientôt' }[j.phase] || '';
}

async function chooseTake(takeId) {
  try {
    const updated = await api('POST', `/api/v1/segments/${S.segmentId}/choose`, { takeId });
    const idx = S.project.segments.findIndex((s) => s.id === updated.id);
    S.project.segments[idx] = updated;
    renderTabs();
    renderTakes();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Comparaison A/B : bascule au même instant ----------
function setAB(slot, takeId) {
  abStop();
  S.ab[slot] = S.ab[slot] === takeId ? null : takeId;
  renderTakes();
}

function abStop() {
  if (S.abPlaying) {
    players.get(S.ab[S.abPlaying])?.audio.pause();
    S.abPlaying = null;
  }
}

function abToggle() {
  const a = players.get(S.ab.A);
  const b = players.get(S.ab.B);
  if (!a || !b) return;
  if (!S.abPlaying) {
    a.audio.currentTime = 0;
    a.audio.play().catch(() => {});
    S.abPlaying = 'A';
  } else {
    const from = S.abPlaying === 'A' ? a : b;
    const to = S.abPlaying === 'A' ? b : a;
    const t = from.audio.currentTime;
    to.audio.currentTime = Math.min(t, to.audio.duration || t);
    to.audio.play().catch(() => {});
    S.abPlaying = S.abPlaying === 'A' ? 'B' : 'A';
  }
  renderAbBar();
}

function renderAbBar() {
  const zone = $('#ab-zone');
  if (!zone) return;
  const seg = segment();
  const ta = seg?.takes.find((t) => t.id === S.ab.A);
  const tb = seg?.takes.find((t) => t.id === S.ab.B);
  if (!ta || !tb) { fill(zone); return; }
  fill(zone, h('div', { class: 'ab-bar' },
    h('strong', {}, 'A/B'),
    h('span', {}, `A : ${toneLabel(ta.finalText)}`),
    h('span', {}, `B : ${toneLabel(tb.finalText)}`),
    h('button', { type: 'button', class: 'ab-switch', onclick: abToggle },
      S.abPlaying ? `J’écoute ${S.abPlaying} · passer à ${S.abPlaying === 'A' ? 'B' : 'A'}` : '▶ Écouter A puis basculer'),
    S.abPlaying ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { abStop(); renderAbBar(); } }, '■ Stop') : null,
    h('span', { class: 'small muted' }, 'La bascule garde la même position dans la phrase.')));
}

// ---------- Liste de lecture et export ----------
let playlist = null;
const playlistAudio = $('#playlist-audio');
playlistAudio.addEventListener('play', () => claimAudio(playlistAudio));

function togglePlaylist(takes) {
  if (playlist) {
    playlistAudio.pause();
    playlist = null;
    renderTabs();
    return;
  }
  playlist = { takes, i: 0 };
  const playNext = () => {
    if (!playlist || playlist.i >= playlist.takes.length) { playlist = null; renderTabs(); return; }
    playlistAudio.src = playlist.takes[playlist.i].audioUrl;
    playlistAudio.play().catch(() => { playlist = null; renderTabs(); });
    playlist.i++;
    renderTabs();
  };
  playlistAudio.onended = playNext;
  playlistAudio.onpause = () => { if (playlist && !playlistAudio.ended) { playlist = null; renderTabs(); } };
  playNext();
}

async function exportZip(takeIds) {
  try {
    const res = await fetch('/api/v1/exports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Capsule-CSRF': '1' }, body: JSON.stringify({ takeIds }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Export impossible.');
    const url = URL.createObjectURL(await res.blob());
    // Nom donné par le serveur (« projet-repliques.zip »), sinon nom daté
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `capsule-${new Date().toISOString().slice(0, 10)}.zip`;
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { toast(e.message, 'error'); }
}

// =====================================================================
// PANNEAU « VOIR L'API »
// =====================================================================
async function showJob(jobId) {
  try {
    const job = await api('GET', `/api/v1/generations/${jobId}`);
    S.jobs.set(jobId, job);
    S.panelJobId = jobId;
    if (!S.apiOpen) toggleApi(true);
    else renderApiPanel();
  } catch (e) { toast(e.message, 'error'); }
}

// Masquage d'affichage en mode tournage (l'identifiant de voix n'est pas un secret)
function displayBody(body) {
  return S.filming ? { ...body, reference_id: '•••• (masqué en mode tournage)' } : body;
}

function requestBlock(request) {
  const headers = Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  return h('pre', { class: 'code', 'aria-label': 'Requête envoyée' },
    `${request.method} ${request.url}\n${headers}\n\n${JSON.stringify(displayBody(request.body), null, 2)}`);
}

function copyButtons(request) {
  const body = JSON.stringify(request.body, null, 2);
  const curl = [
    `curl -X POST '${FISH_TTS_URL}' \\`,
    `  -H "Authorization: Bearer $FISH_API_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'model: ${request.headers.model}' \\`,
    `  --data '${body.replace(/'/g, "'\\''")}' \\`,
    `  --output prise.${request.body.format}`
  ].join('\n');
  const js = [
    `// Node 18+ : la clé vient de la variable d'environnement FISH_API_KEY`,
    `const res = await fetch('${FISH_TTS_URL}', {`,
    `  method: 'POST',`,
    `  headers: {`,
    '    Authorization: `Bearer ${process.env.FISH_API_KEY}`,',
    `    'Content-Type': 'application/json',`,
    `    model: '${request.headers.model}'`,
    `  },`,
    `  body: JSON.stringify(${body.replace(/\n/g, '\n  ')})`,
    `});`,
    `await (await import('node:fs/promises')).writeFile('prise.${request.body.format}', Buffer.from(await res.arrayBuffer()));`
  ].join('\n');
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} copié. L’exécuter déclencherait une nouvelle génération.`); }
    catch { toast('Copie impossible dans ce navigateur.', 'error'); }
  };
  return [
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => copy(curl, 'Exemple curl') }, 'Copier l’exemple curl'),
      h('button', { class: 'btn small', type: 'button', onclick: () => copy(js, 'Exemple JavaScript') }, 'Copier l’exemple JS')),
    h('p', { class: 'muted small mt-8' }, 'La clé n’est jamais copiée : l’exemple lit la variable $FISH_API_KEY.')
  ];
}

const PHASES = [
  ['prepared', 'Requête préparée'],
  ['queued', 'En file d’attente'],
  ['sent', 'Envoyée à Fish Audio'],
  ['receiving', 'Audio reçu (premier octet)'],
  ['done', 'Fichier prêt et vérifié']
];

function timeline(job) {
  const order = ['prepared', 'queued', 'sending', 'sent', 'receiving', 'done'];
  const reached = job.state === 'succeeded' ? 'done' : job.phase;
  const idx = order.indexOf(reached === 'sending' ? 'queued' : reached === 'retry_wait' ? 'sent' : reached);
  const times = { prepared: job.timings.queuedAt, queued: job.timings.queuedAt, sent: job.timings.sentAt, receiving: job.timings.firstByteAt, done: job.timings.finishedAt };
  const items = PHASES.map(([key, label]) => {
    const i = order.indexOf(key);
    const cls = job.state === 'succeeded' || i < idx ? 'done' : i === idx ? 'current' : '';
    return h('li', { class: cls }, label, h('span', { class: 't' }, times[key] && (cls === 'done' || cls === 'current') ? fmtTime(times[key]) : ''));
  });
  if (job.state === 'failed' || job.state === 'uncertain') {
    items.push(h('li', { class: 'error' }, job.state === 'uncertain' ? 'Résultat incertain' : 'Erreur', h('span', { class: 't' }, fmtTime(job.timings.finishedAt))));
  }
  if (job.phase === 'retry_wait') items.push(h('li', { class: 'current' }, 'Limite de débit (429) : nouvel essai après délai'));
  return h('ol', { class: 'timeline' }, items);
}

function renderApiPanel() {
  const col = $('#api-col');
  if (!col) return;
  const flow = h('div', { class: 'flow', 'aria-hidden': 'true' },
    h('span', { class: 'node' }, 'Studio'), h('span', { class: 'arrow' }, '→'),
    h('span', { class: 'node' }, 'API Fish Audio'), h('span', { class: 'arrow' }, '→'),
    h('span', { class: 'node' }, 'Audio'), h('span', { class: 'arrow' }, '→'),
    h('span', { class: 'node' }, 'Écoute'));
  const head = h('div', { class: 'drawer-head' },
    h('h2', {}, 'Voir l’API'),
    h('button', { class: 'btn ghost small icon-btn', type: 'button', 'aria-label': 'Fermer le panneau API', onclick: () => toggleApi(false) }, '✕'));
  const sub = h('p', { class: 'sub' }, 'Ce qui part chez Fish Audio, et ce qui revient.');

  const job = S.panelJobId ? S.jobs.get(S.panelJobId) : null;
  let content;
  if (job) {
    const r = job.response;
    content = [
      h('div', { class: 'row' },
        h('span', { class: `pill ${job.state === 'succeeded' ? 'ok' : job.state === 'failed' ? 'danger' : job.state === 'uncertain' ? 'warn' : ''}` }, stateLabel(job.state)),
        h('span', { class: 'muted small' }, toneLabel(jobText(job))),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { S.panelJobId = null; renderApiPanel(); } }, 'Aperçu du texte actuel')),
      timeline(job),
      requestBlock(job.request),
      h('div', { class: 'metrics' },
        h('div', { class: 'metric' }, h('small', {}, 'Réponse'), h('b', {}, job.httpStatus ? String(job.httpStatus) : '—')),
        h('div', { class: 'metric' }, h('small', {}, 'Premier octet'), h('b', {}, fmtMs(job.timings.ttfbMs))),
        h('div', { class: 'metric' }, h('small', {}, 'Total'), h('b', {}, fmtMs(job.timings.totalMs)))),
      job.error ? h('p', { class: 'error-box small' }, job.error.message) : null,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Modèle demandé'), h('dd', {}, h('code', {}, job.modelRequested)),
        h('dt', {}, 'Modèle confirmé'), h('dd', {}, 'non communiqué par l’API'),
        h('dt', {}, 'Texte envoyé'), h('dd', {}, `${job.bytes} octets UTF-8`),
        h('dt', {}, 'Audio reçu'), h('dd', {}, r ? `${r.contentType} · ${(r.sizeBytes / 1024).toFixed(1).replace('.', ',')} Ko · ${fmtSec(r.durationSec)}` : '—'),
        h('dt', {}, 'Attente en file'), h('dd', {}, fmtMs(job.timings.queueMs)),
        h('dt', { class: 'sensitive' }, 'Tâche'), h('dd', { class: 'sensitive' }, h('code', {}, job.id))),
      h('p', { class: 'muted small' }, 'Le fichier est lu une fois complet : ce n’est pas du streaming temps réel.'),
      copyButtons(job.request)
    ];
  } else {
    // Aperçu construit avec le même code que l'envoi réel
    const d = S.draft;
    const v = voice(voiceIdFor(segment()));
    const model = modelInfo(S.modelKey);
    if (d && model) {
      const finalText = buildFinalText(d.spokenText, d.instruction);
      const req = redactedRequest(model.providerId, buildTtsBody(finalText, v ? v.referenceId : '(aucune voix)', S.audio));
      content = [
        h('div', { class: 'row' }, h('span', { class: 'pill' }, 'Préparée, pas encore envoyée')),
        requestBlock(req),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Modèle demandé'), h('dd', {}, h('code', {}, model.providerId)),
          h('dt', {}, 'Texte'), h('dd', {}, `${utf8Bytes(finalText)} octets UTF-8`)),
        h('p', { class: 'muted small' }, 'Rien ne part du navigateur : le serveur local ajoute la clé et envoie la requête.'),
        copyButtons(req)
      ];
    } else {
      content = [h('p', { class: 'muted' }, 'Sélectionnez un segment pour voir la requête.')];
    }
  }
  fill(col, head, sub, flow, content);
}

function stateLabel(state) {
  return { queued: 'En file', running: 'En cours', succeeded: 'Terminé', failed: 'Erreur', uncertain: 'Résultat incertain' }[state] || state;
}

// =====================================================================
// PROPOSITIONS DE L'AGENT
// =====================================================================
// Différence mot à mot (plus longue sous-séquence commune)
function wordDiff(a, b) {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(h('del', {}, x[i++]));
    else out.push(h('ins', {}, y[j++]));
  }
  while (i < x.length) out.push(h('del', {}, x[i++]));
  while (j < y.length) out.push(h('ins', {}, y[j++]));
  return out;
}

async function renderProposals() {
  const view = $('#view');
  let items;
  try { items = (await api('GET', '/api/v1/proposals')).items; } catch (e) { toast(e.message, 'error'); return; }
  if (!location.hash.startsWith('#/propositions')) return;
  const pending = items.filter((p) => p.state === 'proposed');
  const others = items.filter((p) => p.state !== 'proposed').slice(0, 20);
  const card = (p) => {
    const model = modelInfo(p.requestedModelKey);
    // Dialogue : voix de l'intervenant dans le projet en priorité
    const v = voice(p.castVoiceId) || voice(p.voiceId) || voice(S.voiceId);
    const project = S.projects.find((x) => x.id === p.projectId);
    const currentFinal = p.current ? buildFinalText(p.current.spokenText, p.current.instruction) : '';
    return h('article', { class: 'card proposal' },
      h('div', { class: 'card-head' },
        h('h2', {}, p.title || (p.segmentId ? 'Révision d’un segment' : 'Nouveau segment')),
        h('span', { class: `pill ${p.state === 'proposed' ? 'warn' : p.state === 'approved' ? 'ok' : ''}` }, { proposed: 'À valider', approved: 'Acceptée', rejected: 'Refusée', obsolete: 'Obsolète' }[p.state] || p.state)),
      h('p', { class: 'muted small' }, `Proposée par ${p.createdBy === 'agent' ? 'l’agent' : 'vous'} · ${fmtDate(p.createdAt)} · projet ${project?.name ?? '—'}`),
      p.note ? h('p', { class: 'small' }, 'Note de l’agent : ', p.note) : null,
      p.current
        ? [h('h3', {}, 'Différence avec le texte actuel'), h('div', { class: 'diff' }, wordDiff(currentFinal, p.finalText))]
        : [h('h3', {}, 'Texte proposé'), h('div', { class: 'final-text' }, ...finalTextNode(p.finalText, p.deliveryInstruction))],
      h('dl', { class: 'kv' },
        h('dt', {}, 'Intention'), h('dd', {}, intentLabel(p.deliveryInstruction)),
        h('dt', {}, 'Modèle demandé'), h('dd', {}, `${model?.label ?? p.requestedModelKey}${model && !model.allowed ? ` (bloqué : ${model.reason})` : ''}`),
        p.dialogue ? [h('dt', {}, 'Intervenant'), h('dd', {}, h('span', { class: `spk spk-${p.speaker}` }, p.speaker), p.speakerName ? ` ${p.speakerName}` : '')] : null,
        h('dt', {}, 'Voix'), h('dd', {}, v?.name ?? 'aucune voix prête'),
        h('dt', {}, 'Volume'), h('dd', {}, `${utf8Bytes(p.finalText)} octets UTF-8 · ${model?.paid ? 'payant' : '0 $ (offre gratuite)'}`)),
      p.state === 'proposed' ? h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', disabled: !model?.allowed || !v || !S.caps.fishConfigured, onclick: () => decide(p, 'accept', true, v) }, 'Accepter et générer (1 appel)'),
        h('button', { class: 'btn', type: 'button', onclick: () => decide(p, 'accept', false) }, 'Accepter le texte seulement'),
        h('button', { class: 'btn ghost danger', type: 'button', onclick: () => decide(p, 'reject') }, 'Refuser')) : null,
      p.state === 'approved' ? h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openSegment(p.projectId, p.resultSegmentId) }, 'Ouvrir dans le studio'),
        p.generationIds.length ? h('span', { class: 'muted small' }, `${p.generationIds.length} génération(s) lancée(s)`) : null) : null);
  };
  fill(view, h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h2', {}, 'Propositions de l’agent'),
      h('p', { class: 'muted' }, 'L’agent propose un texte et une intention. Rien ne part chez Fish Audio sans votre validation.')),
    pending.length ? pending.map(card) : h('p', { class: 'muted' }, 'Aucune proposition en attente.'),
    others.length ? [h('h2', {}, 'Historique'), others.map(card)] : null));
}

async function decide(p, decision, generateAfter = false, v = null) {
  try {
    const res = await api('POST', `/api/v1/proposals/${p.id}/decision`, { decision });
    if (generateAfter && res.state === 'approved') {
      const plan = await api('POST', '/api/v1/generation-plans', {
        segmentId: res.resultSegmentId, revisionId: res.resultRevisionId, voiceId: v.id, modelKey: p.requestedModelKey, proposalId: p.id, audio: S.audio
      });
      await api('POST', `/api/v1/generation-plans/${plan.id}/approve`);
      const job = await api('POST', '/api/v1/generations', { planId: plan.id }, { 'Idempotency-Key': crypto.randomUUID() });
      S.jobs.set(job.id, job);
      S.panelJobId = job.id;
      toast('Proposition acceptée, génération lancée.');
      await openSegment(p.projectId, res.resultSegmentId, true);
      pollJobs();
      return;
    }
    toast(decision === 'reject' ? 'Proposition refusée.' : 'Texte accepté.');
    refreshProposalBadge();
    renderProposals();
  } catch (e) {
    toast(e.message, 'error');
    renderProposals();
  }
}

async function openSegment(projectId, segmentId, keepPanel = false) {
  S.projectId = projectId;
  await loadProjects();
  S.segmentId = segmentId;
  S.draft = null;
  if (!keepPanel) S.panelJobId = null;
  refreshProposalBadge();
  location.hash = '#/studio';
  route();
}

// =====================================================================
// VOIX
// =====================================================================
function renderVoices() {
  const view = $('#view');
  const stateLabels = { ready: 'Prête', pending: 'À revérifier', refused: 'Non utilisable' };
  const rows = S.voices.map((v) => h('tr', {},
    h('td', {}, voicePlayButton(v)),
    h('td', {}, v.name),
    h('td', {}, h('span', { class: `pill ${v.state === 'ready' ? 'ok' : v.state === 'refused' ? 'danger' : 'warn'}` }, stateLabels[v.state] || v.state),
      v.stateReason ? h('div', { class: 'muted small' }, v.stateReason) : null),
    h('td', {}, v.source === 'clone' ? 'Clone privé' : 'Référence existante'),
    h('td', {}, v.visibility ?? '—'),
    h('td', { class: 'sensitive' }, h('code', {}, v.referenceId)),
    h('td', {}, fmtDate(v.verifiedAt)),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        try { await api('POST', `/api/v1/voices/${v.id}/verify`); await loadVoices(); renderVoices(); toast('Voix revérifiée.'); } catch (e) { toast(e.message, 'error'); }
      } }, 'Revérifier'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        await api('POST', `/api/v1/voices/${v.id}/archive`); await loadVoices(); renderVoices();
      } }, 'Archiver')))));

  fill(view, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Voix autorisées'),
      S.voices.length ? h('table', { class: 'simple' },
        h('thead', {}, h('tr', {}, [h('span', { class: 'visually-hidden' }, 'Écouter'), 'Nom', 'État', 'Origine', 'Visibilité', h('span', { class: 'sensitive' }, 'Référence'), 'Vérifiée', ''].map((c) => h('th', { class: c === 'Référence' ? 'sensitive' : null }, c)))),
        h('tbody', {}, rows)) : h('p', { class: 'muted' }, 'Aucune voix pour l’instant.')),
    accountVoices(),
    catalogVoices(),
    cloneForm(),
    importForm()));
  fetchMissingSamples();
}

// Ouverture de l'onglet : liste rechargée (dernières prises de chaque voix à jour)
function openVoices() {
  loadVoices().catch(() => {}).then(() => { if (location.hash.startsWith('#/voix')) renderVoices(); });
}

// Bouton d'écoute d'un extrait (voix autorisées et catalogue) : ▶ / ❚❚, une seule écoute à la fois
let sampleAudio = null;
function samplePlayButton(id, src, label, title) {
  const play = h('button', { type: 'button', class: 'play play-sm', disabled: !src, 'aria-label': `Écouter « ${label} »`, title }, '▶');
  play.addEventListener('click', () => {
    // Second clic sur le même extrait : pause
    if (sampleAudio && !sampleAudio.paused && sampleAudio.dataset.id === id) { sampleAudio.pause(); return; }
    sampleAudio?.pause();
    const audio = new Audio(src);
    audio.dataset.id = id;
    const sync = () => { play.textContent = audio.paused || audio.ended ? '▶' : '❚❚'; };
    ['play', 'pause', 'ended'].forEach((e) => audio.addEventListener(e, sync));
    sampleAudio = audio;
    claimAudio(audio);
    audio.play().catch(() => toast('Lecture impossible.', 'error'));
  });
  return play;
}

// Voix autorisée : extrait Fish Audio, sinon dernière prise faite avec cette voix
function voicePlayButton(v) {
  const title = v.sampleUrl ? 'Écouter l’extrait Fish Audio' : v.lastTakeUrl ? 'Écouter la dernière prise faite avec cette voix' : 'Pas encore d’extrait : générez une phrase avec cette voix';
  return samplePlayButton(v.id, v.sampleUrl || v.lastTakeUrl, v.name, title);
}

// Voix ajoutées avant l'écoute : extrait Fish relevé une seule fois, en silence (simple lecture chez Fish, gratuit)
let samplesFetched = false;
async function fetchMissingSamples() {
  if (samplesFetched || !S.caps.fishConfigured) return;
  const missing = S.voices.filter((v) => !('sampleUrl' in v));
  if (!missing.length) return;
  samplesFetched = true;
  for (const v of missing) {
    try { await api('POST', `/api/v1/voices/${v.id}/verify`); } catch { /* voix injoignable : on garde la dernière prise */ }
  }
  await loadVoices();
  if (location.hash.startsWith('#/voix')) renderVoices();
}

// Voix du compte Fish Audio : chargées automatiquement, ajoutées sur confirmation des droits
function accountVoices() {
  const body = h('div', {}, h('p', { class: 'muted' }, S.caps.fishConfigured ? 'Chargement des voix de votre compte…' : 'Clé Fish Audio absente : configurez-la pour lister vos voix.'));
  const section = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, 'Voix de mon compte Fish Audio'),
      h('span', { class: 'muted small' }, 'Vos voix uniquement, jamais le catalogue public.')),
    body);
  if (!S.caps.fishConfigured) return section;

  api('GET', '/api/v1/voices/account').then(({ items }) => {
    if (!items.length) { fill(body, h('p', { class: 'muted' }, 'Aucune voix sur votre compte. Créez-en une avec le clonage privé ci-dessous.')); return; }
    const visLabel = { private: 'Privée', unlist: 'Non répertoriée', public: 'Publique' };
    fill(body, h('table', { class: 'simple' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', {}, 'État'), h('th', {}, 'Visibilité'), h('th', {}, ''))),
      h('tbody', {}, items.map((v) => {
        const action = h('td', {});
        if (v.localVoiceId) fill(action, h('span', { class: 'pill ok' }, 'Déjà ajoutée'));
        else if (!v.usable) fill(action, h('span', { class: 'muted small' }, 'Non utilisable pour l’instant'));
        else {
          // Deux temps : bouton, puis confirmation explicite des droits
          const err = h('p', { class: 'form-error', role: 'alert' });
          const rights = h('input', { type: 'checkbox', id: `av-${v.id}` });
          const confirmBox = h('div', { hidden: true },
            h('label', { class: 'check', for: `av-${v.id}` }, rights, 'Je confirme détenir les droits sur cette voix.'),
            h('button', { class: 'btn primary small', type: 'button', onclick: async () => {
              if (!rights.checked) { err.textContent = 'Cochez la confirmation des droits.'; return; }
              try {
                await api('POST', '/api/v1/voices/import', { name: v.title || 'Voix sans nom', referenceId: v.id, rightsConfirmed: true });
                await loadVoices();
                renderVoices();
                toast(`Voix « ${v.title} » ajoutée.`);
              } catch (e) { err.textContent = e.message; }
            } }, 'Ajouter'), err);
          const start = h('button', { class: 'btn small', type: 'button', onclick: () => { start.hidden = true; confirmBox.hidden = false; rights.focus(); } }, 'Utiliser cette voix');
          fill(action, start, confirmBox);
        }
        return h('tr', {},
          h('td', {}, v.title || '—'),
          h('td', {}, v.state === 'trained' ? 'Entraînée' : v.state || '—'),
          h('td', {}, h('span', { class: `pill ${v.visibility === 'public' ? 'warn' : v.visibility === 'private' ? 'ok' : ''}` }, visLabel[v.visibility] || v.visibility || '—'),
            v.visibility === 'public' ? h('div', { class: 'small warn-text' }, 'Utilisable par n’importe qui sur Fish Audio. À repasser en privé sur fish.audio si ce n’est pas voulu.') : null),
          action);
      }))));
  }).catch((e) => fill(body, h('p', { class: 'error-box small' }, e.message)));
  return section;
}

// Catalogue public : voix françaises sous licence Fish Audio par défaut, filtrées par étiquettes
function catalogVoices() {
  const chosen = new Set();
  let page = 1;
  const all = h('input', { type: 'checkbox', id: 'cat-all' });
  const warn = h('p', { class: 'small warn-text', hidden: true }, 'Voix publiées par la communauté : beaucoup imitent des personnes réelles sans leur accord. Vérifiez les droits avant tout usage public.');
  const info = h('p', { class: 'muted small', role: 'status' });
  const list = h('div', { class: 'cat-list' });
  const more = h('button', { class: 'btn small ghost', type: 'button', hidden: true, onclick: () => { page += 1; search(true); } }, 'Voir plus de voix');

  // Ligne d'une voix : écoute, nom, étiquettes traduites, ajout en deux temps
  const row = (v) => {
    const play = samplePlayButton(v.id, v.sampleUrl, v.title, v.sampleUrl ? 'Écouter l’échantillon' : 'Pas d’échantillon');
    const action = h('div', {});
    if (v.localVoiceId) fill(action, h('span', { class: 'pill ok' }, 'Déjà ajoutée'));
    else {
      const ok = h('input', { type: 'checkbox', id: `cat-${v.id}` });
      const err = h('p', { class: 'form-error', role: 'alert' });
      const box = h('div', { hidden: true },
        h('label', { class: 'check', for: `cat-${v.id}` }, ok, v.licensed ? 'Je respecterai la licence Fish Audio de cette voix.' : 'Je confirme avoir le droit d’utiliser cette voix.'),
        h('button', { class: 'btn primary small', type: 'button', onclick: async () => {
          if (!ok.checked) { err.textContent = 'Cochez la confirmation.'; return; }
          try {
            await api('POST', '/api/v1/voices/import', { name: v.title || 'Voix du catalogue', referenceId: v.id, rightsConfirmed: true });
            await loadVoices();
            renderVoices();
            toast(`Voix « ${v.title} » ajoutée.`);
          } catch (e) { err.textContent = e.message; }
        } }, 'Ajouter'), err);
      const startBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { startBtn.hidden = true; box.hidden = false; ok.focus(); } }, 'Ajouter');
      fill(action, startBtn, box);
    }
    // Étiquettes connues, en français, dans l'ordre des filtres
    const labels = Object.keys(VOICE_TAGS).filter((t) => v.tags.includes(t)).map((t) => VOICE_TAGS[t]);
    return h('div', { class: 'cat-row' }, play,
      h('div', {}, h('b', {}, v.title || '—'),
        h('div', { class: 'muted small' }, [v.author && `par ${v.author}`, v.uses !== null && `${v.uses.toLocaleString('fr-FR')} utilisations`].filter(Boolean).join(' · ')),
        labels.length ? h('div', { class: 'cat-tags' }, labels.map((l) => h('span', {}, l))) : null),
      h('span', { class: `pill ${v.licensed ? 'ok' : 'warn'}` }, v.licensed ? 'Sous licence' : 'Communauté'),
      action);
  };

  const search = async (append = false) => {
    if (!append) { page = 1; fill(list); }
    info.textContent = 'Recherche…';
    more.hidden = true;
    warn.hidden = !all.checked;
    try {
      const { items, hasMore } = await api('GET', `/api/v1/voices/catalog?tags=${[...chosen].join(',')}${all.checked ? '&all=1' : ''}&page=${page}`);
      list.append(...items.map(row));
      const n = list.children.length;
      info.textContent = n ? `${n} voix${hasMore ? ' (il y en a d’autres)' : ''}, les plus utilisées d’abord.`
        : all.checked ? 'Aucune voix ne correspond : retirez un filtre.' : 'Aucune voix sous licence ne correspond : retirez un filtre ou incluez les voix de la communauté.';
      more.hidden = !hasMore;
    } catch (e) { info.textContent = ''; fill(list, h('p', { class: 'error-box small' }, e.message)); }
  };

  // Filtres : un clic ajoute ou retire l'étiquette ; Homme/Femme et l'âge restent exclusifs
  const filters = h('div', { class: 'cat-filters' }, VOICE_TAG_GROUPS.map((g) => h('div', { class: 'cat-filter-group', role: 'group', 'aria-label': g.label },
    h('small', {}, g.label),
    g.tags.map(([tag, label]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
      const on = !chosen.has(tag);
      if (g.label !== 'Style') g.tags.forEach(([t]) => chosen.delete(t));
      if (on) chosen.add(tag); else chosen.delete(tag);
      e.currentTarget.parentElement.querySelectorAll('.chip').forEach((b, i) => b.setAttribute('aria-pressed', String(chosen.has(g.tags[i][0]))));
      search();
    } }, label)))));
  all.addEventListener('change', () => search());

  const section = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, 'Catalogue Fish Audio'),
      h('span', { class: 'muted small' }, 'Voix françaises, sous licence Fish Audio par défaut.')),
    filters,
    h('label', { class: 'check', for: 'cat-all' }, all, 'Inclure les voix de la communauté (droits non vérifiés)'),
    warn, info, list, more);
  if (S.caps.fishConfigured) search();
  else info.textContent = 'Clé Fish Audio absente : configurez-la pour parcourir le catalogue.';
  return section;
}

function importForm() {
  const name = h('input', { type: 'text', id: 'iv-name', maxlength: '80' });
  const ref = h('input', { type: 'text', id: 'iv-ref', maxlength: '64', pattern: '[A-Za-z0-9_-]+' });
  const rights = h('input', { type: 'checkbox', id: 'iv-rights' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  return h('section', { class: 'card sensitive' },
    h('details', {},
      h('summary', { class: 'summary-link' }, 'Ajouter une voix existante (identifiant Fish Audio)'),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!name.value.trim() || !/^[A-Za-z0-9_-]{1,64}$/.test(ref.value.trim())) { err.textContent = 'Nom et identifiant valides requis.'; return; }
        if (!rights.checked) { err.textContent = 'Confirmez vos droits sur cette voix.'; return; }
        try {
          await api('POST', '/api/v1/voices/import', { name: name.value, referenceId: ref.value.trim(), rightsConfirmed: true });
          await loadVoices();
          renderVoices();
          toast('Voix vérifiée et ajoutée.');
        } catch (ex) { err.textContent = ex.message; }
      } },
      h('label', { for: 'iv-name' }, 'Nom local'), name,
      h('label', { for: 'iv-ref' }, 'Identifiant de voix (reference_id)'), ref,
      h('p', { class: 'muted small' }, 'Le serveur vérifie l’existence et l’état de la voix chez Fish Audio. La disponibilité technique ne vaut pas licence commerciale.'),
      h('label', { class: 'check' }, rights, 'Je confirme détenir les droits nécessaires sur cette voix.'),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Vérifier et ajouter'))));
}

function cloneForm() {
  const title = h('input', { type: 'text', id: 'cv-title', maxlength: '80', placeholder: 'ex. Ma voix – voix off' });
  const file = h('input', { type: 'file', id: 'cv-file', accept: 'audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3' });
  const preview = h('audio', { controls: true, hidden: true, class: 'w-full mt-6' });
  const info = h('p', { class: 'muted small', id: 'cv-info' });
  const transcript = h('textarea', { id: 'cv-transcript', rows: '3', placeholder: 'Ce que vous dites dans l’échantillon (recommandé)' });
  const enhance = h('input', { type: 'checkbox', id: 'cv-enhance' });
  const consent = h('input', { type: 'checkbox', id: 'cv-consent' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer et créer une voix privée');
  let duration = null;
  let objectUrl = null;

  file.addEventListener('change', () => {
    err.textContent = '';
    duration = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const f = file.files[0];
    if (!f) { preview.hidden = true; info.textContent = ''; return; }
    objectUrl = URL.createObjectURL(f);
    preview.src = objectUrl;
    preview.hidden = false;
    preview.onloadedmetadata = () => {
      duration = preview.duration;
      info.textContent = `${(f.size / 1024 / 1024).toFixed(1).replace('.', ',')} Mio · ${duration.toFixed(1).replace('.', ',')} s · écoutez l’échantillon avant l’envoi.`;
    };
  });

  return h('section', { class: 'card' },
    h('h2', {}, 'Cloner une voix (privée)'),
    h('div', { class: 'info-box' },
      h('p', {}, h('strong', {}, 'Le fichier audio et la transcription sont envoyés à Fish Audio'), ' pour créer une voix privée. Ils quittent cette machine.'),
      h('p', { class: 'small' }, 'Sans transcription, Fish Audio transcrit automatiquement l’échantillon. Utilisez votre voix, ou une voix dont vous avez l’accord du locuteur.')),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const f = file.files[0];
      // Validation côté client (le serveur revérifie signature, taille et durée)
      if (!title.value.trim()) { err.textContent = 'Titre requis.'; return; }
      if (!f) { err.textContent = 'Choisissez un fichier WAV ou MP3.'; return; }
      if (f.size > 20 * 1024 * 1024) { err.textContent = 'Fichier trop volumineux (20 Mio max).'; return; }
      if (duration !== null && (duration < 10 || duration > 60)) { err.textContent = 'La durée doit être entre 10 et 60 secondes.'; return; }
      if (!consent.checked) { err.textContent = 'Le consentement du locuteur est obligatoire.'; return; }
      const fd = new FormData();
      fd.append('title', title.value.trim());
      fd.append('file', f);
      fd.append('transcript', transcript.value.trim());
      fd.append('consent', 'true');
      fd.append('enhanceAudio', enhance.checked ? 'true' : 'false');
      submit.disabled = true;
      submit.textContent = 'Envoi à Fish Audio…';
      try {
        const res = await fetch('/api/v1/voices/clone', { method: 'POST', headers: { 'X-Capsule-CSRF': '1' }, body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error?.message || 'Clonage impossible.');
        await loadVoices();
        renderVoices();
        toast(data.state === 'ready' ? 'Clone privé prêt (visibilité privée vérifiée).' : `Voix créée, état : ${data.stateReason || data.state}`);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
        submit.textContent = 'Envoyer et créer une voix privée';
      }
    } },
    h('label', { for: 'cv-title' }, 'Nom de la voix'), title,
    h('label', { for: 'cv-file' }, 'Échantillon : un seul locuteur, WAV ou MP3, 10 à 60 s, 20 Mio max'), file, preview, info,
    h('label', { for: 'cv-transcript' }, 'Transcription (facultative)'), transcript,
    h('label', { class: 'check' }, enhance, 'Amélioration audio par Fish Audio (traitement supplémentaire, désactivé par défaut)'),
    h('label', { class: 'check' }, consent, 'Je confirme que cette voix est la mienne ou que le locuteur a donné son accord explicite.'),
    err, submit));
}

// =====================================================================
// RÉGLAGES
// =====================================================================
// Accueil rechargé après l'enregistrement de la clé (pastille et étapes à jour)
async function renderWelcomeAgain() {
  await loadCaps();
  route();
}

// Carte « Clé Fish Audio » : saisie, vérification par le serveur, jamais réaffichée
function fishKeyCard({ intro = false, source = null, onSaved } = {}) {
  const configured = S.caps.fishConfigured;
  const input = h('input', { type: 'password', id: 'fish-key', autocomplete: 'off', spellcheck: 'false', placeholder: configured ? 'Coller une nouvelle clé pour remplacer l’actuelle' : 'Collez votre clé API Fish Audio' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    err.textContent = '';
    if (!input.value.trim()) { err.textContent = 'Collez d’abord la clé.'; input.focus(); return; }
    save.disabled = true;
    save.textContent = 'Vérification…';
    try {
      const r = await api('POST', '/api/v1/settings', { fishApiKey: input.value.trim() });
      input.value = '';
      toast(r.warning || 'Clé Fish Audio vérifiée et enregistrée.', r.warning ? 'error' : 'info');
      onSaved?.();
    } catch (e) { err.textContent = e.message; }
    save.disabled = false;
    save.textContent = 'Enregistrer la clé';
  } }, 'Enregistrer la clé');
  const sourceText = source === 'env' ? ' (fichier .env)' : '';
  return h('section', { class: 'card' },
    h('h2', {}, intro ? 'Étape 0 : votre clé Fish Audio' : 'Connexion Fish Audio'),
    intro
      ? h('p', {}, 'Capsule Studio utilise votre propre compte Fish Audio. Créez une clé sur ',
        h('a', { href: 'https://fish.audio/app/api-keys/', target: '_blank', rel: 'noopener noreferrer' }, 'fish.audio → API Keys'), ', puis collez-la ici.')
      : h('p', {}, 'Clé API : ', h('span', { class: `pill ${configured ? 'ok' : 'warn'}` }, configured ? `configurée${sourceText}` : 'absente')),
    h('label', { for: 'fish-key' }, 'Clé API Fish Audio'),
    h('div', { class: 'row' }, input, save),
    err,
    h('p', { class: 'muted small' }, 'La clé est vérifiée auprès de Fish Audio, puis enregistrée sur cet ordinateur uniquement (dossier des données). Elle n’est jamais réaffichée ni envoyée au navigateur.'),
    configured && source === 'settings' && !intro
      ? h('button', { class: 'btn ghost danger small', type: 'button', onclick: async () => {
        try { await api('POST', '/api/v1/settings', { fishApiKey: null }); toast('Clé retirée.'); onSaved?.(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Retirer la clé')
      : null);
}

// Générations payantes : interrupteur, budgets, Drama 3 et date de fin de l'offre gratuite
function paidCard(s) {
  const st = s.settings;
  const allow = h('input', { type: 'checkbox', id: 'paid-allow', checked: st.allowPaid });
  const budget = h('input', { type: 'number', id: 'paid-budget', min: '0.01', max: '10000', step: '0.01', value: st.paidBudgetTotalUsd ?? '', class: 'num-input' });
  const perReq = h('input', { type: 'number', id: 'paid-req', min: '0.01', max: '10000', step: '0.01', value: st.paidMaxPerRequestUsd ?? '', class: 'num-input' });
  const drama = h('input', { type: 'checkbox', id: 'paid-drama', checked: st.enableDrama3 });
  const endDate = h('input', { type: 'date', id: 'offer-end', value: st.freeOfferEndDate, class: 'num-input' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const numOrNull = (el) => (el.value === '' ? null : Number(el.value));
  const save = async () => {
    err.textContent = '';
    try {
      await api('POST', '/api/v1/settings', {
        allowPaid: allow.checked, paidBudgetTotalUsd: numOrNull(budget), paidMaxPerRequestUsd: numOrNull(perReq),
        enableDrama3: drama.checked, freeOfferEndDate: endDate.value || null
      });
      toast('Réglages enregistrés.');
      await loadCaps();
      renderSettings();
    } catch (e) { err.textContent = e.message; }
  };
  return h('section', { class: 'card' },
    h('h2', {}, 'Générations payantes'),
    h('p', { class: 'muted small' }, 'Désactivées par défaut. Une fois autorisées, chaque génération payante affiche son coût estimé avant approbation, dans la limite des plafonds ci-dessous (dépense réservée à ce jour : ', fmtUsd(s.paid.reservedUsd ?? 0), ').'),
    h('label', { class: 'check', for: 'paid-allow' }, allow, h('b', {}, 'Autoriser les générations payantes (S2.1 Pro)')),
    h('div', { class: 'row mt-12' }, h('label', { for: 'paid-budget' }, 'Budget total ($)'), budget, h('label', { for: 'paid-req' }, 'Plafond par requête ($)'), perReq),
    h('label', { class: 'check mt-12', for: 'paid-drama' }, drama, 'Activer Drama 3 (payant, plus expressif)'),
    h('div', { class: 'row mt-12' }, h('label', { for: 'offer-end' }, 'Fin de l’offre gratuite S2.1 Pro Free'), endDate,
      h('a', { class: 'small', href: s.freeOffer.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Conditions Fish Audio')),
    err,
    h('div', { class: 'row mt-12' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Enregistrer')));
}

// Garde-fous : générations par jour (modifiable) et rappel des limites fixes
function limitsCard(s) {
  const max = h('input', { type: 'number', id: 'max-day', min: '1', max: '9999', step: '1', value: String(s.settings.maxGenerationsPerDay), class: 'num-input' });
  max.addEventListener('change', async () => {
    try { await api('POST', '/api/v1/settings', { maxGenerationsPerDay: Number(max.value) }); toast('Limite quotidienne enregistrée.'); await loadCaps(); renderSettings(); } catch (e) { toast(e.message, 'error'); max.value = String(s.settings.maxGenerationsPerDay); }
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'Garde-fous'),
    h('div', { class: 'row' }, h('label', { for: 'max-day' }, 'Générations par jour (au plus)'), max,
      h('span', { class: 'muted small' }, `${s.limits.generationsToday} aujourd’hui`)),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Texte max par segment'), h('dd', {}, `${s.limits.maxBytesPerSegment} octets UTF-8`),
      h('dt', {}, 'Prises par action groupée'), h('dd', {}, String(s.limits.maxTakesPerBatch)),
      h('dt', {}, 'Offre gratuite'), h('dd', {}, `${s.freeOffer.active ? 'active' : 'terminée'} jusqu’au ${s.freeOffer.endDate} (${s.freeOffer.timezone})`),
      h('dt', { class: 'sensitive' }, 'Données locales'), h('dd', { class: 'sensitive' }, h('code', {}, s.dataDir))));
}

// Réseau local : interrupteur (pris en compte au prochain lancement) et adresses
function lanCard(s) {
  const on = h('input', { type: 'checkbox', id: 'lan-on', checked: s.settings.lan });
  on.addEventListener('change', async () => {
    try { await api('POST', '/api/v1/settings', { lan: on.checked }); toast('Pris en compte au prochain lancement de Capsule Studio.'); renderSettings(); } catch (e) { toast(e.message, 'error'); on.checked = !on.checked; }
  });
  const restart = s.settings.lan !== s.lan.active && !(s.settings.lan && s.lan.error);
  return h('section', { class: 'card' },
    h('h2', {}, 'Accès depuis le réseau local'),
    h('label', { class: 'check', for: 'lan-on' }, on, h('span', {}, h('b', {}, 'Ouvrir Capsule Studio aux autres postes du réseau local'),
      h('span', { class: 'muted small' }, ' (HTTPS, adresses privées uniquement, même mot de passe)'))),
    restart ? h('p', { class: 'warn-box mt-12' }, 'Relancez Capsule Studio pour appliquer ce changement.') : null,
    s.lan.active
      ? [h('p', { class: 'mt-12' }, 'Depuis un autre poste du réseau, ouvrez l’une de ces adresses :'),
        h('ul', {}, s.lan.urls.map((u) => h('li', {}, h('code', {}, u)))),
        h('p', { class: 'muted small' }, 'Connexion chiffrée (HTTPS) avec un certificat créé sur ce PC. Pour éviter l’avertissement du navigateur, sur l’autre poste : téléchargez le certificat, double-cliquez dessus, « Installer le certificat », « Utilisateur actuel », « Placer tous les certificats dans le magasin suivant » → « Autorités de certification racines de confiance », puis redémarrez le navigateur.'),
        h('a', { class: 'btn small', href: '/capsule-studio-reseau.cer', download: 'capsule-studio-reseau.cer' }, 'Télécharger le certificat')]
      : s.lan.enabled && s.lan.error ? h('p', { class: 'blocked' }, `Activé mais indisponible : ${s.lan.error}.`) : null);
}
// Mode autonome de l'agent : interrupteur et plafond quotidien, enregistrés dès qu'ils changent
function autonomyBox(s) {
  const a = s.agentAutonomy;
  const on = h('input', { type: 'checkbox', id: 'agent-auto', checked: a.enabled });
  const limit = h('input', { type: 'number', id: 'agent-limit', min: '1', max: String(s.limits.maxGenerationsPerDay), step: '1', value: String(a.dailyLimit), class: 'num-input' });
  const save = async () => {
    try {
      const r = await api('POST', '/api/v1/settings/agent-autonomy', { enabled: on.checked, dailyLimit: Number(limit.value) });
      toast(r.enabled ? `Mode autonome activé (${r.dailyLimit} générations par jour pour l’agent).` : 'Mode autonome coupé : l’agent ne peut plus que proposer.');
    } catch (e) { toast(e.message, 'error'); on.checked = a.enabled; limit.value = String(a.dailyLimit); }
  };
  on.addEventListener('change', save);
  limit.addEventListener('change', save);
  return h('div', { class: 'compare-panel mt-12' },
    h('label', { class: 'check', for: 'agent-auto' }, on, h('b', {}, 'Mode autonome')),
    h('p', { class: 'small' }, 'L’agent travaille seul : il crée les projets, règle le dialogue (voix A/B parmi vos voix autorisées), écrit et modifie les segments, génère, choisit les prises et règle le montage.'),
    h('p', { class: 'muted small' }, 'Toujours interdit à l’agent : modèle payant, création, import ou archivage de voix, archivage de projets ou de segments, réglages, budgets, jeton.'),
    h('div', { class: 'row' },
      h('label', { for: 'agent-limit' }, 'Plafond de l’agent'), limit, h('span', { class: 'muted small' }, `générations par jour · ${a.generationsToday} aujourd’hui`)));
}

async function renderSettings() {
  const view = $('#view');
  let s;
  try { s = await api('GET', '/api/v1/settings'); } catch (e) { toast(e.message, 'error'); return; }
  const tokenOut = h('div', {});
  fill(view, h('div', { class: 'stack' },
    fishKeyCard({ source: s.settings.fishKey.source, onSaved: async () => { await loadCaps(); renderSettings(); } }),
    h('section', { class: 'card' },
      h('h2', {}, 'Modèles'),
      h('table', { class: 'simple' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Modèle'), h('th', {}, 'Identifiant envoyé'), h('th', {}, 'Tarif publié'), h('th', {}, 'État'))),
        h('tbody', {}, s.models.map((m) => h('tr', {},
          h('td', {}, m.label), h('td', {}, h('code', {}, m.providerId)),
          h('td', {}, `${m.pricePerMillionBytes} $ / million d’octets`),
          h('td', {}, m.allowed ? h('span', { class: 'pill ok' }, 'Utilisable') : h('span', { class: 'pill warn' }, m.reason)))))),
      h('p', { class: 'muted small' }, 'Tarifs relevés le 22/10/2026 sur la grille Fish Audio. Les générations payantes sont désactivées par défaut.')),
    paidCard(s),
    h('section', { class: 'card' },
      h('h2', {}, 'Accès agent (IA externe)'),
      h('p', {}, 'Jeton agent : ', h('span', { class: `pill ${s.agentToken.configured ? 'ok' : 'warn'}` }, s.agentToken.configured ? 'actif' : 'aucun'),
        s.agentToken.createdAt ? h('span', { class: 'muted small' }, ` créé le ${fmtDate(s.agentToken.createdAt)}`) : null),
      h('p', { class: 'muted small' }, 'Ce jeton permet à un agent IA (Claude, ChatGPT, Hermes, OpenClaw, un script…) de proposer des textes et de suivre les générations par l’API locale. Il ne donne jamais accès à la clé Fish Audio, aux voix, aux budgets ni aux réglages.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const r = await api('POST', '/api/v1/settings/agent-token');
          fill(tokenOut, h('div', { class: 'warn-box' }, h('p', {}, r.warning), h('pre', { class: 'code' }, r.token),
            h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(r.token).then(() => toast('Jeton copié.')) }, 'Copier le jeton')));
        } }, s.agentToken.configured ? 'Régénérer le jeton (l’ancien est révoqué)' : 'Générer un jeton agent'),
        s.agentToken.configured && !s.agentToken.fromEnv ? h('button', { class: 'btn ghost danger', type: 'button', onclick: async () => { await api('POST', '/api/v1/settings/agent-token/revoke'); renderSettings(); } }, 'Révoquer') : null),
      tokenOut,
      autonomyBox(s),
      h('p', { class: 'small' }, 'Mode d’emploi pour l’agent : docs/AGENT-USAGE.md')),
    limitsCard(s),
    lanCard(s),
    h('section', { class: 'card' },
      h('h2', {}, 'Démonstration'),
      h('p', { class: 'muted' }, 'Crée un projet « Introduction de tutoriel » avec des textes fictifs sur les sauvegardes de fichiers.'),
      h('button', { class: 'btn', type: 'button', onclick: createDemo }, 'Créer le projet de démonstration'))));
}

// ---------- Démarrage ----------
applyFilming();
try {
  await loadCaps();
  await Promise.all([loadProjects(), loadVoices()]);
  await refreshProposalBadge();
  route();
  // Propositions de l'agent : vérification régulière
  setInterval(refreshProposalBadge, 4000);
} catch (e) {
  fill($('#view'), h('div', { class: 'error-box' }, `Chargement impossible : ${e.message}`));
}
