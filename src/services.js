// Service applicatif commun à l'interface web et à l'agent.
// Toutes les règles métier (révisions, plans, approbations, quotas) vivent ici.
import crypto from 'node:crypto';
import { newId } from './store.js';
import { getModel, modelAvailability, publicModels, freeOfferState, localDate, DEFAULT_MODEL_KEY } from './models.js';
import { buildFinalText, utf8Bytes, buildTtsBody, redactedRequest, estimateUsd, AUDIO_PARAMS, INTENTS, cleanAudioOptions, FORMATS, normalizeInstruction, VOICE_TAGS, cleanMontage, sniffMusic, MUSIC_FORMATS } from '../shared/payload.js';
import { analyzeAudio, finalizeWav } from './audio.js';
import { ProviderError } from './fish.js';
import { log, redactString, registerSecret } from './redact.js';
import { applySettings, APP_VERSION } from './config.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isOwner = (actor) => actor?.role === 'owner';
const iso = (d = new Date()) => d.toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function requireOwner(actor) {
  if (!isOwner(actor)) throw new AppError(403, 'forbidden', 'Action réservée au propriétaire.');
}

function str(value, { max, field, required = false }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AppError(400, 'invalid', `Champ « ${field} » requis.`);
    return '';
  }
  if (typeof value !== 'string') throw new AppError(400, 'invalid', `Champ « ${field} » invalide.`);
  const v = value.trim();
  if (required && !v) throw new AppError(400, 'invalid', `Champ « ${field} » requis.`);
  if (v.length > max) throw new AppError(400, 'invalid', `Champ « ${field} » trop long (${max} caractères max).`);
  return v;
}

export function createServices({ store, config, fish, audioStore, now = () => new Date() }) {
  // ---------- Mode autonome de l'agent ----------
  // Activé par le propriétaire : l'agent peut alors créer et générer seul, sur le modèle gratuit uniquement,
  // dans un plafond quotidien qui lui est propre. Voix, réglages, budgets et jeton restent réservés au propriétaire.
  const autonomy = () => ({ enabled: false, dailyLimit: 100, ...(store.data.agentAutonomy ?? {}) });

  function requireOwnerOrAutonomous(actor) {
    if (isOwner(actor)) return;
    if (actor?.role === 'agent' && autonomy().enabled) return;
    if (actor?.role === 'agent') throw new AppError(403, 'autonomy_off', 'Mode autonome désactivé : le propriétaire doit l’activer dans Réglages → Accès agent.');
    throw new AppError(403, 'forbidden', 'Action réservée au propriétaire.');
  }

  // Générations approuvées par l'agent aujourd'hui (exécutées ou non)
  const agentApprovedToday = () => store.list('plans', (p) => p.approval?.day === todayKey() && p.approval?.by === 'agent').length;

  function setAgentAutonomy(actor, body) {
    requireOwner(actor);
    if (typeof body?.enabled !== 'boolean') throw new AppError(400, 'invalid', 'Champ « enabled » attendu (vrai ou faux).');
    const dailyLimit = body.dailyLimit ?? autonomy().dailyLimit;
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > config.maxGenerationsPerDay) {
      throw new AppError(400, 'invalid', `Plafond de l’agent invalide (1 à ${config.maxGenerationsPerDay}).`);
    }
    store.tx((db) => { db.agentAutonomy = { enabled: body.enabled, dailyLimit, updatedAt: iso(now()) }; });
    return agentAutonomyView();
  }

  const agentAutonomyView = () => ({ enabled: autonomy().enabled, dailyLimit: autonomy().dailyLimit, generationsToday: agentApprovedToday() });

  // ---------- Réglages modifiables depuis l'interface ----------
  // Enregistrés dans db.settings ; une valeur absente (null) reprend celle du fichier .env ou la valeur par défaut.
  const savedSettings = () => store.data.settings ?? {};
  registerSecret(savedSettings().fishApiKey);
  applySettings(config, savedSettings());
  fish.setApiKey?.(config.fishApiKey);

  // Vue sans secret : la clé Fish n'est jamais renvoyée, seulement son état et sa provenance
  function settingsView() {
    const s = savedSettings();
    const fromSettings = (k) => s[k] !== null && s[k] !== undefined;
    return {
      fishKey: {
        configured: Boolean(config.fishApiKey),
        source: fromSettings('fishApiKey') ? 'settings' : config.base.fishApiKey ? 'env' : null
      },
      allowPaid: config.allowPaid,
      paidBudgetTotalUsd: config.paidBudgetTotalUsd,
      paidMaxPerRequestUsd: config.paidMaxPerRequestUsd,
      enableDrama3: config.enableDrama3,
      maxGenerationsPerDay: config.maxGenerationsPerDay,
      freeOfferEndDate: config.freeOffer.endDate,
      lan: config.lan
    };
  }

  // Contrôle d'un réglage reçu ; undefined = inchangé, null = retour à la valeur du .env / par défaut
  function checkSetting(key, v) {
    if (v === undefined || v === null) return v;
    const bad = (msg) => { throw new AppError(400, 'invalid', msg); };
    switch (key) {
      case 'allowPaid': case 'enableDrama3': case 'lan':
        return typeof v === 'boolean' ? v : bad(`Réglage « ${key} » : vrai ou faux attendu.`);
      case 'paidBudgetTotalUsd': case 'paidMaxPerRequestUsd':
        return typeof v === 'number' && v > 0 && v <= 10000 ? v : bad('Plafond de dépense invalide (plus de 0 et au plus 10 000 $).');
      case 'maxGenerationsPerDay':
        return Number.isInteger(v) && v >= 1 && v <= 9999 ? v : bad('Générations par jour : entier de 1 à 9 999.');
      case 'freeOfferEndDate':
        return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : bad('Date de fin de l’offre invalide (AAAA-MM-JJ).');
      default:
        return bad(`Réglage inconnu : ${key}.`);
    }
  }

  async function updateSettings(actor, body) {
    requireOwner(actor);
    if (!body || typeof body !== 'object') throw new AppError(400, 'invalid', 'Réglages attendus.');
    const next = { ...savedSettings() };
    for (const [k, v] of Object.entries(body)) {
      if (k === 'fishApiKey') continue;
      const value = checkSetting(k, v);
      if (value !== undefined) next[k] = value;
    }
    // Cohérence des plafonds payants
    const merged = applySettings({ ...config, base: config.base, freeOffer: { ...config.freeOffer } }, next);
    if (merged.allowPaid && !(merged.paidBudgetTotalUsd > 0 && merged.paidMaxPerRequestUsd > 0)) {
      throw new AppError(400, 'invalid', 'Pour autoriser les générations payantes, renseignez le budget total et le plafond par requête.');
    }
    if (merged.paidMaxPerRequestUsd > merged.paidBudgetTotalUsd) {
      throw new AppError(400, 'invalid', 'Le plafond par requête ne peut pas dépasser le budget total.');
    }
    // Plafond de l'agent ramené sous le nouveau maximum quotidien
    const agentLimit = Math.min(autonomy().dailyLimit, merged.maxGenerationsPerDay);

    // Clé Fish : vérifiée auprès de Fish Audio avant d'être enregistrée
    let warning = null;
    if (body.fishApiKey !== undefined) {
      if (body.fishApiKey === null || body.fishApiKey === '') {
        next.fishApiKey = null;
      } else {
        if (typeof body.fishApiKey !== 'string' || !/^[\x21-\x7e]{16,200}$/.test(body.fishApiKey.trim())) {
          throw new AppError(400, 'invalid', 'Clé Fish Audio invalide (copiez-la depuis fish.audio → API Keys).');
        }
        const key = body.fishApiKey.trim();
        registerSecret(key);
        const previous = config.fishApiKey;
        fish.setApiKey?.(key);
        try {
          await fish.listOwnVoices();
        } catch (e) {
          if (e instanceof ProviderError && e.code === 'auth') {
            fish.setApiKey?.(previous);
            throw new AppError(400, 'fish_key_refused', 'Clé refusée par Fish Audio : vérifiez-la puis réessayez.');
          }
          warning = 'Clé enregistrée mais non vérifiée (Fish Audio injoignable pour le moment).';
        }
        next.fishApiKey = key;
      }
    }

    store.tx((db) => {
      db.settings = { ...next, updatedAt: iso(now()) };
      if (db.agentAutonomy && db.agentAutonomy.dailyLimit > agentLimit) db.agentAutonomy.dailyLimit = agentLimit;
    });
    applySettings(config, store.data.settings);
    fish.setApiKey?.(config.fishApiKey);
    return { settings: settingsView(), warning };
  }

  // ---------- Utilitaires ----------
  const must = (collection, id, label) => {
    const item = store.get(collection, id);
    if (!item) throw new AppError(404, 'not_found', `${label} introuvable.`);
    return item;
  };

  const checkBytes = (finalText) => {
    const bytes = utf8Bytes(finalText);
    if (bytes > config.maxBytesPerSegment) {
      throw new AppError(400, 'too_long', `Texte trop long : ${bytes} octets UTF-8 (limite ${config.maxBytesPerSegment}).`);
    }
    return bytes;
  };

  const todayKey = () => localDate(now(), config.freeOffer.timezone);

  // ---------- Vues ----------
  function voiceView(v, actor) {
    const view = { id: v.id, name: v.name, state: v.state, visibility: v.visibility, source: v.source, verifiedAt: v.verifiedAt, stateReason: v.stateReason ?? null };
    if (isOwner(actor)) view.referenceId = v.referenceId;
    // Écoute : extrait Fish Audio (null si la voix n'en a pas, absent si jamais relevé) et dernière prise faite avec la voix
    if (v.sampleUrl !== undefined) view.sampleUrl = v.sampleUrl;
    const last = store.list('takes', (t) => t.voiceId === v.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    view.lastTakeUrl = last ? `/api/v1/takes/${last.id}/audio` : null;
    return view;
  }

  function takeView(t) {
    const seg = store.get('segments', t.segmentId);
    return {
      id: t.id,
      segmentId: t.segmentId,
      revisionId: t.revisionId,
      jobId: t.jobId,
      modelKey: t.modelKey,
      modelLabel: getModel(t.modelKey)?.label ?? t.modelKey,
      modelRequested: t.modelRequested,
      providerReportedModel: t.providerReportedModel,
      voiceId: t.voiceId,
      voiceName: t.voiceName,
      instruction: t.instruction,
      audioOptions: t.audioOptions ?? null,
      finalText: t.finalText,
      durationSec: t.durationSec,
      sizeBytes: t.sizeBytes,
      costEstimateUsd: t.costEstimateUsd,
      createdAt: t.createdAt,
      source: t.source,
      chosen: seg?.chosenTakeId === t.id,
      audioUrl: `/api/v1/takes/${t.id}/audio`
    };
  }

  function costLabel(model, usd) {
    if (usd === null) return 'Coût inconnu';
    if (!model.paid) return 'Coût TTS estimé 0 $, sous validité de l’offre';
    return `Estimation ${usd.toFixed(6)} $ (tarif publié, pas une facture)`;
  }

  function planView(p) {
    const model = getModel(p.modelKey);
    return {
      id: p.id,
      state: p.state,
      segmentId: p.segmentId,
      revisionId: p.revisionId,
      voiceId: p.voiceId,
      voiceName: p.voiceName,
      modelKey: p.modelKey,
      modelLabel: model?.label,
      modelRequested: p.providerModel,
      instruction: p.instruction,
      finalText: p.finalText,
      bytes: p.bytes,
      costEstimateUsd: p.costEstimateUsd,
      costLabel: costLabel(model, p.costEstimateUsd),
      calls: 1,
      request: redactedRequest(p.providerModel, p.body),
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      approvedAt: p.approval?.approvedAt ?? null,
      approvalExpiresAt: p.approval?.expiresAt ?? null,
      jobId: p.jobId ?? null
    };
  }

  function jobView(j) {
    const plan = store.get('plans', j.planId);
    const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
    return {
      id: j.id,
      state: j.state,
      phase: j.phase,
      planId: j.planId,
      segmentId: plan?.segmentId ?? null,
      modelKey: plan?.modelKey ?? null,
      modelRequested: plan?.providerModel ?? null,
      providerReportedModel: null,
      instruction: plan?.instruction ?? null,
      audioOptions: plan?.audioOptions ?? null,
      bytes: plan?.bytes ?? null,
      costEstimateUsd: plan?.costEstimateUsd ?? null,
      request: plan ? redactedRequest(plan.providerModel, plan.body) : null,
      httpStatus: j.httpStatus ?? null,
      response: j.response ?? null,
      attempts: j.attempts,
      actor: j.actor,
      timings: {
        queuedAt: j.queuedAt,
        sentAt: j.sentAt ?? null,
        firstByteAt: j.firstByteAt ?? null,
        finishedAt: j.finishedAt ?? null,
        queueMs: ms(j.queuedAt, j.sentAt),
        ttfbMs: j.ttfbMs ?? null,
        totalMs: ms(j.queuedAt, j.finishedAt)
      },
      error: j.error ?? null,
      takeId: j.takeId ?? null,
      audioUrl: j.state === 'succeeded' && j.takeId ? `/api/v1/takes/${j.takeId}/audio` : null
    };
  }

  // ---------- Capacités ----------
  function capabilities() {
    return {
      app: 'Capsule Studio',
      version: APP_VERSION,
      instanceLabel: config.instanceLabel || null,
      fishConfigured: Boolean(fish.configured),
      models: publicModels(config, now()),
      defaultModelKey: DEFAULT_MODEL_KEY,
      intents: INTENTS,
      audio: AUDIO_PARAMS,
      freeOffer: freeOfferState(config, now()),
      limits: {
        maxBytesPerSegment: config.maxBytesPerSegment,
        maxGenerationsPerDay: config.maxGenerationsPerDay,
        maxTakesPerBatch: config.maxTakesPerBatch,
        generationsToday: store.list('jobs', (j) => j.day === todayKey()).length
      },
      paid: {
        allowed: config.allowPaid,
        budgetTotalUsd: config.paidBudgetTotalUsd,
        maxPerRequestUsd: config.paidMaxPerRequestUsd,
        reservedUsd: store.data.paidReservedUsd
      },
      features: { clone: true, proposals: true, exports: true },
      agentAutonomy: agentAutonomyView()
    };
  }

  // ---------- Projets et segments ----------
  function listProjects() {
    return store.list('projects', (p) => !p.archived).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function createProject(actor, body) {
    requireOwnerOrAutonomous(actor);
    const name = str(body?.name, { max: 120, field: 'name', required: true });
    const p = { id: newId('prj'), name, archived: false, createdBy: actor.role, createdAt: iso(now()), updatedAt: iso(now()) };
    store.tx((db) => { db.projects[p.id] = p; });
    return p;
  }

  function archiveProject(actor, id) {
    requireOwner(actor);
    must('projects', id, 'Projet');
    store.tx((db) => { db.projects[id].archived = true; db.projects[id].updatedAt = iso(now()); });
    return { id, archived: true };
  }

  function segmentView(s) {
    const revision = store.get('revisions', s.currentRevisionId);
    const takes = store.list('takes', (t) => t.segmentId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      id: s.id,
      projectId: s.projectId,
      order: s.order,
      title: s.title,
      currentRevisionId: s.currentRevisionId,
      chosenTakeId: s.chosenTakeId ?? null,
      speaker: s.speaker ?? 'A',
      revision: revision && {
        id: revision.id,
        spokenText: revision.spokenText,
        instruction: revision.instruction,
        finalText: revision.finalText,
        bytes: utf8Bytes(revision.finalText),
        author: revision.author,
        createdAt: revision.createdAt
      },
      revisionCount: store.list('revisions', (r) => r.segmentId === s.id).length,
      takes: takes.map(takeView)
    };
  }

  function getProject(id) {
    const project = must('projects', id, 'Projet');
    const segments = store.list('segments', (s) => s.projectId === id && !s.archived).sort((a, b) => a.order - b.order);
    return {
      ...project,
      // Monologue (une voix) ou dialogue (voix A et B, attribuées par segment)
      mode: project.mode ?? 'mono',
      voices: { A: project.voiceA ?? null, B: project.voiceB ?? null },
      names: { A: project.nameA ?? '', B: project.nameB ?? '' },
      // Réglages de la page Montage (null tant que rien n'a été enregistré)
      montage: project.montage ?? null,
      // Musique de fond du montage (fichier servi par /projects/:id/music)
      music: project.music ? { name: project.music.name, size: project.music.size, format: project.music.format, uploadedAt: project.music.uploadedAt } : null,
      segments: segments.map(segmentView)
    };
  }

  // Réglages du projet : mode, voix A/B et noms des intervenants
  function setProjectCast(actor, id, body) {
    requireOwnerOrAutonomous(actor);
    must('projects', id, 'Projet');
    const mode = body?.mode ?? 'mono';
    if (!['mono', 'dialogue'].includes(mode)) throw new AppError(400, 'invalid', 'Mode invalide (mono ou dialogue).');
    const voiceRef = (v, field) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string') throw new AppError(400, 'invalid', `Champ « ${field} » invalide.`);
      if (must('voices', v, 'Voix').archived) throw new AppError(400, 'invalid', 'Voix archivée.');
      return v;
    };
    const patch = {
      mode,
      voiceA: voiceRef(body?.voices?.A, 'voices.A'),
      voiceB: voiceRef(body?.voices?.B, 'voices.B'),
      nameA: str(body?.names?.A ?? '', { max: 40, field: 'names.A' }),
      nameB: str(body?.names?.B ?? '', { max: 40, field: 'names.B' }),
      updatedAt: iso(now())
    };
    store.tx((db) => Object.assign(db.projects[id], patch));
    return getProject(id);
  }

  // Montage : silence, réglages des pistes et décalages des segments, validés puis enregistrés
  function setProjectMontage(actor, id, body) {
    requireOwnerOrAutonomous(actor);
    must('projects', id, 'Projet');
    const m = cleanMontage(body);
    if (!m) throw new AppError(400, 'invalid', 'Réglages de montage invalides.');
    // Décalages limités aux segments de ce projet
    const own = new Set(store.list('segments', (s) => s.projectId === id).map((s) => s.id));
    m.nudges = Object.fromEntries(Object.entries(m.nudges).filter(([sid]) => own.has(sid)));
    m.edits = Object.fromEntries(Object.entries(m.edits).filter(([sid]) => own.has(sid)));
    store.tx((db) => { db.projects[id].montage = m; db.projects[id].updatedAt = iso(now()); });
    return getProject(id);
  }

  // Musique de fond : un fichier par projet, format vérifié par sa signature, l'ancien est remplacé
  function setProjectMusic(actor, id, { buffer, name }) {
    requireOwner(actor);
    const project = must('projects', id, 'Projet');
    if (!buffer || buffer.length < 1024) throw new AppError(400, 'invalid_audio', 'Fichier audio vide ou trop court.');
    const format = sniffMusic(buffer);
    if (!format) throw new AppError(400, 'invalid_audio', 'Format non reconnu : envoyez un fichier WAV, MP3, OGG, FLAC ou M4A.');
    const label = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || `musique.${format}`;
    const file = audioStore.save(newId('music'), buffer, format);
    const old = project.music?.file;
    store.tx((db) => {
      db.projects[id].music = { file, name: label, size: buffer.length, format, uploadedAt: iso(now()) };
      db.projects[id].updatedAt = iso(now());
    });
    if (old) audioStore.removeMusic(old);
    return getProject(id);
  }

  function removeProjectMusic(actor, id) {
    requireOwner(actor);
    const project = must('projects', id, 'Projet');
    const old = project.music?.file;
    store.tx((db) => { db.projects[id].music = null; db.projects[id].updatedAt = iso(now()); });
    if (old) audioStore.removeMusic(old);
    return getProject(id);
  }

  // Fichier de la musique (lecture réservée au propriétaire)
  function getProjectMusic(id) {
    const project = must('projects', id, 'Projet');
    if (!project.music) throw new AppError(404, 'not_found', 'Aucune musique pour ce projet.');
    return { data: audioStore.read(project.music.file), mime: MUSIC_FORMATS[project.music.format] };
  }

  // Intervenant d'un segment (A ou B)
  function setSegmentSpeaker(actor, segmentId, speaker) {
    requireOwnerOrAutonomous(actor);
    const seg = must('segments', segmentId, 'Segment');
    if (!['A', 'B'].includes(speaker)) throw new AppError(400, 'invalid', 'Intervenant invalide (A ou B).');
    store.tx((db) => { db.segments[segmentId].speaker = speaker; });
    return getProject(seg.projectId);
  }

  function addRevision(db, segmentId, { spokenText, instruction: rawInstruction, author }) {
    const instruction = normalizeInstruction(rawInstruction);
    const finalText = buildFinalText(spokenText, instruction);
    const r = { id: newId('rev'), segmentId, spokenText, instruction, finalText, author, createdAt: iso(now()) };
    db.revisions[r.id] = r;
    db.segments[segmentId].currentRevisionId = r.id;
    return r;
  }

  function createSegment(actor, projectId, body, author = 'owner') {
    if (author === 'owner') {
      requireOwnerOrAutonomous(actor);
      if (actor.role === 'agent') author = 'agent';
    }
    must('projects', projectId, 'Projet');
    const title = str(body?.title, { max: 120, field: 'title' });
    const spokenText = str(body?.spokenText, { max: 6000, field: 'spokenText', required: true });
    const instruction = normalizeInstruction(str(body?.instruction, { max: 300, field: 'instruction' }));
    checkBytes(buildFinalText(spokenText, instruction));
    const speaker = body?.speaker ?? 'A';
    if (!['A', 'B'].includes(speaker)) throw new AppError(400, 'invalid', 'Intervenant invalide (A ou B).');
    const order = Math.max(0, ...store.list('segments', (s) => s.projectId === projectId).map((s) => s.order)) + 1;
    const seg = { id: newId('seg'), projectId, order, title, speaker, currentRevisionId: null, chosenTakeId: null, archived: false, createdAt: iso(now()) };
    store.tx((db) => {
      db.segments[seg.id] = seg;
      addRevision(db, seg.id, { spokenText, instruction, author });
    });
    return segmentView(store.get('segments', seg.id));
  }

  function createRevision(actor, segmentId, body) {
    requireOwnerOrAutonomous(actor);
    const seg = must('segments', segmentId, 'Segment');
    if (body?.baseRevisionId !== seg.currentRevisionId) {
      throw new AppError(409, 'revision_conflict', 'Le segment a changé depuis la révision de départ.', { currentRevisionId: seg.currentRevisionId });
    }
    const spokenText = str(body?.spokenText, { max: 6000, field: 'spokenText', required: true });
    const instruction = normalizeInstruction(str(body?.instruction, { max: 300, field: 'instruction' }));
    checkBytes(buildFinalText(spokenText, instruction));
    const title = body?.title === undefined ? seg.title : str(body.title, { max: 120, field: 'title' });
    const current = store.get('revisions', seg.currentRevisionId);
    if (current && current.spokenText === spokenText && current.instruction === instruction && title === seg.title) {
      return segmentView(seg); // rien n'a changé : pas de révision vide
    }
    store.tx((db) => {
      db.segments[segmentId].title = title;
      if (!current || current.spokenText !== spokenText || current.instruction !== instruction) {
        addRevision(db, segmentId, { spokenText, instruction, author: actor.role === 'agent' ? 'agent' : 'owner' });
      }
    });
    return segmentView(store.get('segments', segmentId));
  }

  function chooseTake(actor, segmentId, takeId) {
    requireOwnerOrAutonomous(actor);
    must('segments', segmentId, 'Segment');
    if (takeId !== null) {
      const take = must('takes', takeId, 'Prise');
      if (take.segmentId !== segmentId) throw new AppError(400, 'invalid', 'Cette prise appartient à un autre segment.');
    }
    store.tx((db) => { db.segments[segmentId].chosenTakeId = takeId; });
    return segmentView(store.get('segments', segmentId));
  }

  function moveSegment(actor, segmentId, direction) {
    requireOwnerOrAutonomous(actor);
    const seg = must('segments', segmentId, 'Segment');
    const siblings = store.list('segments', (s) => s.projectId === seg.projectId && !s.archived).sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((s) => s.id === segmentId);
    const other = siblings[direction === 'up' ? idx - 1 : idx + 1];
    if (!other) return getProject(seg.projectId);
    store.tx((db) => {
      const o = db.segments[segmentId].order;
      db.segments[segmentId].order = db.segments[other.id].order;
      db.segments[other.id].order = o;
    });
    return getProject(seg.projectId);
  }

  function archiveSegment(actor, segmentId) {
    requireOwner(actor);
    const seg = must('segments', segmentId, 'Segment');
    store.tx((db) => { db.segments[segmentId].archived = true; });
    return getProject(seg.projectId);
  }

  // ---------- Voix ----------
  function listVoices(actor) {
    return store.list('voices', (v) => !v.archived).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((v) => voiceView(v, actor));
  }

  // Interprétation prudente de l'état fournisseur
  function evaluateVoice(remote) {
    if (remote.takenDown) return { state: 'refused', reason: 'Voix retirée ou restreinte par Fish Audio.' };
    if (remote.type !== 'tts') return { state: 'refused', reason: `Type de modèle « ${remote.type} » non TTS.` };
    if (remote.state === 'trained') return { state: 'ready', reason: null };
    if (remote.state === 'failed') return { state: 'refused', reason: 'Création échouée chez Fish Audio.' };
    return { state: 'pending', reason: `État fournisseur « ${remote.state ?? 'inconnu'} » : revérifier plus tard.` };
  }

  async function importVoice(actor, body) {
    requireOwner(actor);
    const name = str(body?.name, { max: 80, field: 'name', required: true });
    const referenceId = str(body?.referenceId, { max: 64, field: 'referenceId', required: true });
    if (body?.rightsConfirmed !== true) throw new AppError(400, 'consent_required', 'Confirmez que vous détenez les droits sur cette voix.');
    if (store.list('voices', (v) => v.referenceId === referenceId && !v.archived).length) {
      throw new AppError(409, 'duplicate', 'Cette voix est déjà enregistrée.');
    }
    const remote = await callProvider(() => fish.getVoice(referenceId));
    const { state, reason } = evaluateVoice(remote);
    const v = { id: newId('voi'), name, referenceId, source: 'import', rightsConfirmed: true, state, stateReason: reason, visibility: remote.visibility, sampleUrl: remote.sampleUrl ?? null, verifiedAt: iso(now()), createdAt: iso(now()), archived: false };
    store.tx((db) => { db.voices[v.id] = v; });
    return voiceView(v, actor);
  }

  // Voix du compte Fish Audio, avec l'indication « déjà ajoutée » localement
  async function listAccountVoices(actor) {
    requireOwner(actor);
    const { total, items } = await callProvider(() => fish.listOwnVoices());
    const local = new Map(store.list('voices', (v) => !v.archived).map((v) => [v.referenceId, v.id]));
    return {
      total,
      items: items.map((v) => ({ ...v, usable: evaluateVoice(v).state === 'ready', localVoiceId: local.get(v.id) ?? null }))
    };
  }

  // Catalogue public : sous licence Fish Audio par défaut ; voix communautaires seulement sur demande
  async function searchCatalog(actor, { tags, all, page }) {
    requireOwner(actor);
    const list = Array.isArray(tags) ? tags : [];
    if (list.length > 6 || list.some((t) => !Object.prototype.hasOwnProperty.call(VOICE_TAGS, t))) throw new AppError(400, 'invalid', 'Filtre de voix inconnu.');
    const p = page ?? 1;
    if (!Number.isInteger(p) || p < 1 || p > 20) throw new AppError(400, 'invalid', 'Page invalide (1 à 20).');
    const { total, hasMore, items } = await callProvider(() => fish.searchVoices({ tags: list, licensedOnly: !all, page: p }));
    const local = new Map(store.list('voices', (v) => !v.archived).map((v) => [v.referenceId, v.id]));
    return {
      total,
      hasMore: Boolean(hasMore),
      items: items.filter((v) => evaluateVoice(v).state === 'ready').map((v) => ({ ...v, localVoiceId: local.get(v.id) ?? null }))
    };
  }

  async function refreshVoice(actor, voiceId) {
    requireOwner(actor);
    const v = must('voices', voiceId, 'Voix');
    const remote = await callProvider(() => fish.getVoice(v.referenceId));
    let { state, reason } = evaluateVoice(remote);
    if (v.source === 'clone' && remote.visibility !== 'private' && state === 'ready') {
      state = 'refused';
      reason = `Visibilité « ${remote.visibility} » au lieu de « private ».`;
    }
    store.tx((db) => Object.assign(db.voices[voiceId], { state, stateReason: reason, visibility: remote.visibility, sampleUrl: remote.sampleUrl ?? null, verifiedAt: iso(now()) }));
    return voiceView(store.get('voices', voiceId), actor);
  }

  async function cloneVoice(actor, { title, file, fileName, consent, transcript, enhanceAudio }) {
    requireOwner(actor);
    if (consent !== true) throw new AppError(400, 'consent_required', 'Consentement du locuteur requis.');
    const name = str(title, { max: 80, field: 'title', required: true });
    const text = str(transcript, { max: 5000, field: 'transcript' });
    if (!Buffer.isBuffer(file) || file.length === 0) throw new AppError(400, 'invalid_file', 'Fichier audio requis.');
    if (file.length > 20 * 1024 * 1024) throw new AppError(400, 'invalid_file', 'Fichier trop volumineux (20 Mio max).');
    const info = analyzeAudio(file);
    if (!info.valid) throw new AppError(400, 'invalid_file', 'Fichier non reconnu : WAV ou MP3 uniquement.');
    if (info.durationSec < 10 || info.durationSec > 60) {
      throw new AppError(400, 'invalid_file', `Durée ${info.durationSec} s : il faut entre 10 et 60 secondes.`);
    }
    const mimeType = info.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const safeName = `echantillon.${info.format}`; // nom généré côté serveur
    const created = await callProvider(() => fish.createVoice({ title: name, file, fileName: safeName, mimeType, transcript: text, enhanceAudio: enhanceAudio === true }));
    // Relecture obligatoire : visibilité privée vérifiée avant d'annoncer « prêt »
    let remote = null;
    let state = 'pending';
    let reason = 'Visibilité non encore vérifiée.';
    try {
      remote = await fish.getVoice(created.id);
      ({ state, reason } = evaluateVoice(remote));
      if (remote.visibility !== 'private') { state = 'refused'; reason = `Visibilité « ${remote.visibility} » au lieu de « private ».`; }
    } catch (e) {
      reason = `Relecture impossible : ${redactString(e.message)}`;
    }
    const v = { id: newId('voi'), name, referenceId: created.id, source: 'clone', rightsConfirmed: true, state, stateReason: reason, visibility: remote?.visibility ?? null, verifiedAt: remote ? iso(now()) : null, sampleDurationSec: info.durationSec, createdAt: iso(now()), archived: false };
    store.tx((db) => { db.voices[v.id] = v; });
    return voiceView(v, actor);
  }

  function archiveVoice(actor, voiceId) {
    requireOwner(actor);
    must('voices', voiceId, 'Voix');
    store.tx((db) => { db.voices[voiceId].archived = true; });
    return { id: voiceId, archived: true };
  }

  // Erreurs fournisseur hors génération → erreurs applicatives lisibles
  async function callProvider(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError) {
        const status = e.code === 'auth' ? 502 : e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : 502;
        throw new AppError(status, `provider_${e.code}`, e.message);
      }
      throw e;
    }
  }

  // ---------- Propositions de l'agent ----------
  function proposalView(p) {
    const seg = p.segmentId ? store.get('segments', p.segmentId) : null;
    const current = seg ? store.get('revisions', seg.currentRevisionId) : null;
    const generations = store.list('plans', (pl) => pl.proposalId === p.id && pl.jobId).map((pl) => pl.jobId);
    // Dialogue : intervenant visé (celui demandé, sinon celui du segment) et sa voix dans le projet
    const project = store.get('projects', p.projectId);
    const dialogue = project?.mode === 'dialogue';
    const speaker = p.speaker ?? seg?.speaker ?? 'A';
    return {
      id: p.id,
      state: p.state,
      projectId: p.projectId,
      segmentId: p.segmentId,
      resultSegmentId: p.resultSegmentId ?? null,
      baseRevisionId: p.baseRevisionId,
      title: p.title,
      spokenText: p.spokenText,
      deliveryInstruction: p.deliveryInstruction,
      finalText: buildFinalText(p.spokenText, p.deliveryInstruction),
      requestedModelKey: p.requestedModelKey,
      voiceId: p.voiceId,
      dialogue,
      speaker,
      speakerName: dialogue ? (speaker === 'A' ? project.nameA : project.nameB) || '' : '',
      castVoiceId: dialogue ? (speaker === 'A' ? project.voiceA : project.voiceB) ?? null : null,
      note: p.note,
      current: current ? { spokenText: current.spokenText, instruction: current.instruction } : null,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt ?? null,
      resultRevisionId: p.resultRevisionId ?? null,
      generationIds: generations,
      reviewUrl: `http://${config.host}:${config.port}/#/propositions`
    };
  }

  function createProposal(actor, body) {
    must('projects', body?.projectId, 'Projet');
    const segmentId = body?.segmentId || null;
    let baseRevisionId = null;
    if (segmentId) {
      const seg = must('segments', segmentId, 'Segment');
      if (seg.projectId !== body.projectId) throw new AppError(400, 'invalid', 'Segment hors du projet.');
      if (body.baseRevisionId !== seg.currentRevisionId) {
        throw new AppError(409, 'revision_conflict', 'La révision de départ n’est plus la révision courante.', { currentRevisionId: seg.currentRevisionId });
      }
      baseRevisionId = seg.currentRevisionId;
    }
    const spokenText = str(body?.spokenText, { max: 6000, field: 'spokenText', required: true });
    const deliveryInstruction = str(body?.deliveryInstruction, { max: 300, field: 'deliveryInstruction' });
    checkBytes(buildFinalText(spokenText, deliveryInstruction));
    const requestedModelKey = body?.requestedModelKey ?? DEFAULT_MODEL_KEY;
    if (!getModel(requestedModelKey)) throw new AppError(400, 'unknown_model', 'Clé de modèle inconnue.');
    const voiceId = body?.voiceId || null;
    if (voiceId) must('voices', voiceId, 'Voix');
    // Intervenant du dialogue (A ou B) : facultatif, appliqué au segment à l'acceptation
    const speaker = body?.speaker ?? null;
    if (speaker !== null && !['A', 'B'].includes(speaker)) throw new AppError(400, 'invalid', 'Intervenant invalide (A ou B).');
    const p = {
      id: newId('prp'),
      state: 'proposed',
      projectId: body.projectId,
      segmentId,
      baseRevisionId,
      title: str(body?.title, { max: 120, field: 'title' }),
      spokenText,
      deliveryInstruction,
      requestedModelKey,
      voiceId,
      speaker,
      note: str(body?.note, { max: 500, field: 'note' }),
      createdBy: actor.role,
      createdAt: iso(now())
    };
    store.tx((db) => { db.proposals[p.id] = p; });
    log({ event: 'proposal_created', state: p.state });
    return proposalView(p);
  }

  function listProposals(filterState) {
    return store.list('proposals', (p) => !filterState || p.state === filterState)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(proposalView);
  }

  function getProposal(id) {
    return proposalView(must('proposals', id, 'Proposition'));
  }

  function decideProposal(actor, id, body) {
    requireOwner(actor);
    const p = must('proposals', id, 'Proposition');
    if (p.state !== 'proposed') throw new AppError(409, 'already_decided', `Proposition déjà ${p.state}.`);
    const decision = body?.decision;
    if (decision === 'reject') {
      store.tx((db) => Object.assign(db.proposals[id], { state: 'rejected', decidedAt: iso(now()) }));
      return proposalView(store.get('proposals', id));
    }
    if (decision !== 'accept') throw new AppError(400, 'invalid', 'Décision attendue : accept ou reject.');
    if (p.segmentId) {
      const seg = must('segments', p.segmentId, 'Segment');
      if (seg.currentRevisionId !== p.baseRevisionId) {
        store.tx((db) => Object.assign(db.proposals[id], { state: 'obsolete', decidedAt: iso(now()) }));
        throw new AppError(409, 'obsolete', 'Le segment a changé depuis la proposition : proposition obsolète.');
      }
      store.tx((db) => {
        const r = addRevision(db, p.segmentId, { spokenText: p.spokenText, instruction: p.deliveryInstruction, author: 'agent' });
        if (p.speaker) db.segments[p.segmentId].speaker = p.speaker;
        Object.assign(db.proposals[id], { state: 'approved', decidedAt: iso(now()), resultRevisionId: r.id, resultSegmentId: p.segmentId });
      });
    } else {
      const seg = createSegment(actor, p.projectId, { title: p.title, spokenText: p.spokenText, instruction: p.deliveryInstruction, speaker: p.speaker ?? 'A' }, 'agent');
      store.tx((db) => Object.assign(db.proposals[id], { state: 'approved', decidedAt: iso(now()), resultRevisionId: seg.currentRevisionId, resultSegmentId: seg.id }));
    }
    return proposalView(store.get('proposals', id));
  }

  // ---------- Plans de génération ----------
  function computePlan({ segmentId, revisionId, instruction, voiceId, modelKey, audio }) {
    const seg = must('segments', segmentId, 'Segment');
    if (seg.archived) throw new AppError(409, 'archived', 'Segment archivé.');
    if (revisionId && revisionId !== seg.currentRevisionId) {
      throw new AppError(409, 'revision_conflict', 'Révision non courante.', { currentRevisionId: seg.currentRevisionId });
    }
    const revision = store.get('revisions', seg.currentRevisionId);
    const model = getModel(modelKey);
    if (!model) throw new AppError(400, 'unknown_model', 'Clé de modèle inconnue : seules s21_free, s21_paid et drama3 sont acceptées.');
    const voice = must('voices', voiceId, 'Voix');
    if (voice.archived || voice.state !== 'ready') throw new AppError(409, 'voice_not_ready', `Voix « ${voice.name} » non utilisable (${voice.state}).`);
    const finalInstruction = instruction === undefined ? revision.instruction : normalizeInstruction(str(instruction, { max: 300, field: 'instruction' }));
    const finalText = buildFinalText(revision.spokenText, finalInstruction);
    const bytes = checkBytes(finalText);
    const audioOptions = cleanAudioOptions(audio);
    if (!audioOptions) throw new AppError(400, 'invalid_audio_options', 'Réglages audio invalides (normalisation : oui/non, volume : entier entre −20 et +6 dB).');
    const body = buildTtsBody(finalText, voice.referenceId, audioOptions);
    const costEstimateUsd = estimateUsd(bytes, model.pricePerMillionBytes);
    const hash = sha256(JSON.stringify([revision.id, finalText, voice.referenceId, model.providerId, AUDIO_PARAMS, audioOptions, model.pricePerMillionBytes]));
    return { seg, revision, model, voice, finalInstruction, finalText, bytes, body, costEstimateUsd, hash, audioOptions };
  }

  function assertModelAllowed(model, costEstimateUsd) {
    const availability = modelAvailability(model.key, config, now());
    if (!availability.allowed) throw new AppError(403, 'model_blocked', availability.reason);
    if (model.paid) {
      if (costEstimateUsd === null) throw new AppError(403, 'unknown_price', 'Tarif inconnu : génération bloquée.');
      if (costEstimateUsd > config.paidMaxPerRequestUsd) throw new AppError(403, 'budget', 'Plafond par requête dépassé.');
    }
  }

  function createPlan(actor, body) {
    const modelKey = body?.modelKey ?? DEFAULT_MODEL_KEY;
    const c = computePlan({ segmentId: body?.segmentId, revisionId: body?.revisionId, instruction: body?.instruction, voiceId: body?.voiceId, modelKey, audio: body?.audio });
    assertModelAllowed(c.model, c.costEstimateUsd);
    if (body?.proposalId) must('proposals', body.proposalId, 'Proposition');
    const plan = {
      id: newId('pln'),
      state: 'pending_approval',
      segmentId: c.seg.id,
      revisionId: c.revision.id,
      proposalId: body?.proposalId ?? null,
      voiceId: c.voice.id,
      voiceName: c.voice.name,
      modelKey: c.model.key,
      providerModel: c.model.providerId,
      instruction: c.finalInstruction,
      audioOptions: c.audioOptions,
      finalText: c.finalText,
      bytes: c.bytes,
      body: c.body,
      costEstimateUsd: c.costEstimateUsd,
      hash: c.hash,
      createdBy: actor.role,
      createdAt: iso(now())
    };
    store.tx((db) => { db.plans[plan.id] = plan; });
    return planView(plan);
  }

  // Le plan est-il toujours identique à ce qui a été approuvé ?
  function planStillValid(plan) {
    try {
      const c = computePlan({ segmentId: plan.segmentId, revisionId: plan.revisionId, instruction: plan.instruction, voiceId: plan.voiceId, modelKey: plan.modelKey, audio: plan.audioOptions });
      return c.hash === plan.hash;
    } catch {
      return false;
    }
  }

  function countToday(db) {
    const day = todayKey();
    const jobs = Object.values(db.jobs).filter((j) => j.day === day).length;
    const approved = Object.values(db.plans).filter((p) => p.state === 'approved' && p.approval?.day === day).length;
    return jobs + approved;
  }

  function approvePlan(actor, planId) {
    requireOwnerOrAutonomous(actor);
    const plan = must('plans', planId, 'Plan');
    if (plan.state !== 'pending_approval') throw new AppError(409, 'invalid_state', `Plan déjà ${plan.state}.`);
    if (!planStillValid(plan)) {
      store.tx((db) => { db.plans[planId].state = 'stale'; });
      throw new AppError(409, 'stale_plan', 'Le texte, la voix, le modèle ou le tarif a changé : préparez un nouveau plan.');
    }
    const model = getModel(plan.modelKey);
    assertModelAllowed(model, plan.costEstimateUsd);
    if (actor.role === 'agent' && model.paid) throw new AppError(403, 'agent_paid', 'En mode autonome, l’agent n’utilise que le modèle gratuit (s21_free).');
    // Réservation atomique : quota quotidien et budget payant
    store.tx((db) => {
      if (countToday(db) >= config.maxGenerationsPerDay) {
        throw new AppError(429, 'daily_quota', `Quota quotidien atteint (${config.maxGenerationsPerDay} générations).`);
      }
      if (actor.role === 'agent' && agentApprovedToday() >= autonomy().dailyLimit) {
        throw new AppError(429, 'agent_quota', `Plafond quotidien de l’agent atteint (${autonomy().dailyLimit} générations).`);
      }
      if (model.paid) {
        if (db.paidReservedUsd + plan.costEstimateUsd > config.paidBudgetTotalUsd) {
          throw new AppError(403, 'budget', 'Budget payant global atteint.');
        }
        db.paidReservedUsd += plan.costEstimateUsd;
      }
      Object.assign(db.plans[planId], {
        state: 'approved',
        approval: { approvedAt: iso(now()), expiresAt: iso(new Date(now().getTime() + config.approvalTtlMs)), day: todayKey(), by: actor.role, reservedUsd: model.paid ? plan.costEstimateUsd : 0 }
      });
    });
    return planView(store.get('plans', planId));
  }

  function getPlan(id) {
    return planView(must('plans', id, 'Plan'));
  }

  function releaseReservation(db, plan) {
    const r = plan.approval?.reservedUsd ?? 0;
    if (r > 0) { db.paidReservedUsd = Math.max(0, db.paidReservedUsd - r); plan.approval.reservedUsd = 0; }
  }

  // ---------- Exécution ----------
  function executePlan(actor, { planId, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
      throw new AppError(400, 'idempotency_key', 'En-tête Idempotency-Key requis (8 à 128 caractères).');
    }
    const existing = store.list('jobs', (j) => j.idempotencyKey === idempotencyKey)[0];
    if (existing) {
      if (existing.planId !== planId) throw new AppError(409, 'idempotency_conflict', 'Clé déjà utilisée pour un autre plan.');
      return { job: jobView(existing), reused: true };
    }
    const plan = must('plans', planId, 'Plan');
    if (plan.state === 'consumed') throw new AppError(409, 'approval_consumed', 'Approbation déjà utilisée.', { jobId: plan.jobId });
    if (plan.state !== 'approved') throw new AppError(403, 'not_approved', 'Plan non approuvé par le propriétaire.');
    if (new Date(plan.approval.expiresAt) < now()) {
      store.tx((db) => { db.plans[planId].state = 'expired'; releaseReservation(db, db.plans[planId]); });
      throw new AppError(409, 'approval_expired', 'Approbation expirée.');
    }
    if (!planStillValid(plan)) {
      store.tx((db) => { db.plans[planId].state = 'stale'; releaseReservation(db, db.plans[planId]); });
      throw new AppError(409, 'stale_plan', 'Le plan ne correspond plus au segment : nouvelle approbation requise.');
    }
    const job = { id: newId('gen'), planId, idempotencyKey, actor: actor.role, state: 'queued', phase: 'queued', attempts: 0, day: todayKey(), queuedAt: iso(now()) };
    store.tx((db) => {
      db.jobs[job.id] = job;
      Object.assign(db.plans[planId], { state: 'consumed', jobId: job.id });
    });
    log({ event: 'job_queued', jobId: job.id, planId, model: plan.providerModel, bytes: plan.bytes });
    setImmediate(() => { worker.kick(); });
    return { job: jobView(job), reused: false };
  }

  function getGeneration(id) {
    return jobView(must('jobs', id, 'Génération'));
  }

  // ---------- Worker (une seule instance, un appel fournisseur à la fois) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const worker = {
    running: false,
    idle: Promise.resolve(),
    backoffMs: (attempt, retryAfterMs) => retryAfterMs ?? 2000 * 2 ** attempt,
    kick() {
      if (this.running) return this.idle;
      this.running = true;
      this.idle = (async () => {
        try {
          for (;;) {
            const next = store.list('jobs', (j) => j.state === 'queued').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
            if (!next) break;
            await runJob(next.id);
          }
        } finally {
          this.running = false;
        }
      })();
      return this.idle;
    }
  };

  const updateJob = (id, patch) => store.tx((db) => Object.assign(db.jobs[id], patch));

  async function runJob(jobId) {
    const plan = store.get('plans', store.get('jobs', jobId).planId);
    updateJob(jobId, { state: 'running', phase: 'sending' });
    for (let attempt = 0; ; attempt++) {
      try {
        updateJob(jobId, { attempts: attempt + 1 });
        const result = await fish.tts({
          providerModel: plan.providerModel,
          body: plan.body,
          onSent: () => updateJob(jobId, { sentAt: iso(now()), phase: 'sent' }),
          onFirstByte: () => updateJob(jobId, { firstByteAt: iso(now()), phase: 'receiving' })
        });
        const expected = plan.audioOptions?.format ?? 'mp3';
        if (expected === 'wav') result.audio = finalizeWav(result.audio);
        const info = analyzeAudio(result.audio);
        if (!info.valid || info.format !== expected || !(info.durationSec > 0)) {
          throw new ProviderError('invalid_audio', result.audio.length ? 'Audio reçu illisible.' : 'Audio vide.', { httpStatus: result.httpStatus });
        }
        const takeId = newId('take');
        const file = audioStore.save(takeId, result.audio, FORMATS[expected].ext);
        const take = {
          id: takeId, segmentId: plan.segmentId, revisionId: plan.revisionId, planId: plan.id, jobId,
          modelKey: plan.modelKey, modelRequested: plan.providerModel, providerReportedModel: null,
          voiceId: plan.voiceId, voiceName: plan.voiceName, instruction: plan.instruction, audioOptions: plan.audioOptions ?? null, finalText: plan.finalText,
          file, sizeBytes: result.audio.length, durationSec: info.durationSec, costEstimateUsd: plan.costEstimateUsd,
          createdAt: iso(now()), source: 'fish_audio'
        };
        store.tx((db) => {
          db.takes[takeId] = take;
          Object.assign(db.jobs[jobId], {
            state: 'succeeded', phase: 'done', finishedAt: iso(now()), httpStatus: result.httpStatus, ttfbMs: result.ttfbMs, takeId,
            response: { contentType: result.contentType, sizeBytes: result.audio.length, durationSec: info.durationSec, sampleRate: info.sampleRate, channels: info.channels }
          });
          // Première prise d'un segment : choisie par défaut, jamais remplacée ensuite
          if (!db.segments[plan.segmentId].chosenTakeId) db.segments[plan.segmentId].chosenTakeId = takeId;
        });
        log({ event: 'job_succeeded', jobId, httpStatus: result.httpStatus, ms: result.totalMs });
        return;
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('uncertain', 'Erreur interne pendant la génération.');
        if (err.code === 'rate_limited' && attempt < 3) {
          updateJob(jobId, { phase: 'retry_wait', httpStatus: 429 });
          await sleep(worker.backoffMs(attempt, err.retryAfterMs));
          continue;
        }
        const state = err.code === 'uncertain' ? 'uncertain' : 'failed';
        store.tx((db) => {
          Object.assign(db.jobs[jobId], { state, phase: 'error', finishedAt: iso(now()), httpStatus: err.httpStatus, error: { code: err.code, message: err.message } });
          // Rejet explicite sans audio : réservation libérée ; résultat incertain : conservée
          if (state === 'failed') releaseReservation(db, db.plans[plan.id]);
        });
        log({ event: 'job_' + state, jobId, httpStatus: err.httpStatus, code: err.code });
        return;
      }
    }
  }

  // Au démarrage : une tâche déjà en cours ne peut pas être prouvée → incertaine, jamais rejouée
  function recoverAfterRestart() {
    const interrupted = store.list('jobs', (j) => j.state === 'running');
    if (interrupted.length) {
      store.tx((db) => {
        for (const j of interrupted) {
          Object.assign(db.jobs[j.id], { state: 'uncertain', phase: 'error', finishedAt: iso(now()), error: { code: 'restart', message: 'Serveur redémarré pendant l’appel : résultat incertain, vérifier avant de relancer.' } });
        }
      });
    }
    if (store.list('jobs', (j) => j.state === 'queued').length) worker.kick();
    return interrupted.length;
  }

  // ---------- Prises ----------
  function getTake(id) {
    return must('takes', id, 'Prise');
  }

  return {
    capabilities, listProjects, createProject, archiveProject, getProject,
    createSegment, createRevision, chooseTake, moveSegment, archiveSegment,
    settingsView, updateSettings,
    setAgentAutonomy, listVoices, listAccountVoices, searchCatalog, setProjectCast, setProjectMontage, setProjectMusic, removeProjectMusic, getProjectMusic, setSegmentSpeaker, importVoice, refreshVoice, cloneVoice, archiveVoice,
    createProposal, listProposals, getProposal, decideProposal,
    createPlan, approvePlan, getPlan, executePlan, getGeneration,
    getTake, takeView, recoverAfterRestart, worker
  };
}
