// Registre fermé des modèles : le client n'envoie qu'une clé interne,
// jamais un identifiant fournisseur. Vérifié sur la doc Fish Audio le 2026-10-22.

const PRICING_URL = 'https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits';

export const MODELS = Object.freeze({
  s21_free: Object.freeze({
    key: 's21_free',
    label: 'S2.1 Pro · offre API gratuite',
    providerId: 's2.1-pro-free',
    paid: false,
    pricePerMillionBytes: 0,
    priceSource: PRICING_URL,
    priceVerifiedAt: '2026-10-22'
  }),
  s21_paid: Object.freeze({
    key: 's21_paid',
    label: 'S2.1 Pro · API payante',
    providerId: 's2.1-pro',
    paid: true,
    pricePerMillionBytes: 15,
    priceSource: PRICING_URL,
    priceVerifiedAt: '2026-10-22'
  }),
  drama3: Object.freeze({
    key: 'drama3',
    label: 'Drama 3 · expérimental',
    // Identifiant identique dans la page TTS et le schéma OpenAPI le 2026-10-22
    providerId: 'drama-3',
    paid: true,
    // Prix catalogue (la promo à 10 $ jusqu'au 12/11/2026 n'est pas utilisée : estimation prudente)
    pricePerMillionBytes: 50,
    priceSource: PRICING_URL,
    priceVerifiedAt: '2026-10-22',
    requiresFlag: 'enableDrama3'
  })
});

export const DEFAULT_MODEL_KEY = 's21_free';

export function getModel(key) {
  return Object.prototype.hasOwnProperty.call(MODELS, key) ? MODELS[key] : null;
}

// Date du jour (AAAA-MM-JJ) dans un fuseau donné
export function localDate(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function freeOfferState(config, now = new Date()) {
  const today = localDate(now, config.freeOffer.timezone);
  const active = today <= config.freeOffer.endDate;
  return { active, today, ...config.freeOffer };
}

// Disponibilité d'un modèle : { allowed, reason }
export function modelAvailability(key, config, now = new Date()) {
  const model = getModel(key);
  if (!model) return { allowed: false, reason: 'Modèle inconnu.' };
  if (model.requiresFlag && !config[model.requiresFlag]) {
    return { allowed: false, reason: 'Drama 3 est désactivé (Réglages → Générations payantes).' };
  }
  if (!model.paid) {
    const offer = freeOfferState(config, now);
    if (!offer.active) return { allowed: false, reason: 'Offre gratuite terminée (date de fin dépassée, modifiable dans Réglages).' };
    return { allowed: true, reason: null };
  }
  if (typeof model.pricePerMillionBytes !== 'number') return { allowed: false, reason: 'Tarif inconnu : génération bloquée.' };
  if (!config.allowPaid) return { allowed: false, reason: 'Générations payantes désactivées (Réglages → Générations payantes).' };
  if (!(config.paidBudgetTotalUsd > 0) || !(config.paidMaxPerRequestUsd > 0)) {
    return { allowed: false, reason: 'Plafonds de dépense absents : à définir dans Réglages → Générations payantes.' };
  }
  return { allowed: true, reason: null };
}

// Vue publique du registre (aucun secret)
export function publicModels(config, now = new Date()) {
  return Object.values(MODELS).map((m) => ({
    key: m.key,
    label: m.label,
    providerId: m.providerId,
    paid: m.paid,
    pricePerMillionBytes: m.pricePerMillionBytes,
    ...modelAvailability(m.key, config, now)
  }));
}
