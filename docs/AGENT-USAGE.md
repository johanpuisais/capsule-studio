# Capsule Studio : guide pour un agent IA

Ce guide s'adresse à un agent externe. Il n'a jamais besoin de la clé Fish Audio.

## Ce que l'agent peut faire

- Lire les capacités, les projets, les segments et les voix.
- **Proposer** un texte et une intention (nouveau segment ou révision d'un segment).
- Préparer un plan de génération et exécuter un plan **déjà approuvé par le propriétaire**.
- Suivre une génération et télécharger la prise.

L'agent ne peut **pas** : approuver, accepter sa propre proposition, cloner une voix, changer les budgets ou les réglages, publier quoi que ce soit.

**Sauf en mode autonome**, activé par le propriétaire dans *Réglages → Accès agent* : l'agent travaille alors seul (voir la section « Mode autonome » plus bas). Vérifier l'état avec `GET /api/v1/capabilities` → `agentAutonomy: { enabled, dailyLimit, generationsToday }`.

## Accès

- Adresse : `http://127.0.0.1:8746` (même machine que Capsule Studio).
- Jeton : généré par le propriétaire dans *Réglages → Accès agent*. Il se passe dans l'en-tête `Authorization: Bearer $CAPSULE_AGENT_TOKEN`.
- **Envoyer le JSON en UTF-8.** Sous Windows, écrire le corps dans un fichier UTF-8 et utiliser `--data-binary @fichier.json`. Un corps mal encodé est refusé (`invalid_encoding`) plutôt que corrompu.

## Parcours type

### 1. Découvrir

```bash
curl -s http://127.0.0.1:8746/api/v1/capabilities -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
curl -s http://127.0.0.1:8746/api/v1/projects     -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
curl -s http://127.0.0.1:8746/api/v1/projects/PROJET_ID -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
curl -s http://127.0.0.1:8746/api/v1/voices       -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
```

Dans le projet, chaque segment donne `id`, `currentRevisionId` et `revision.spokenText` / `revision.instruction`.

### 2. Proposer

Dans le projet, `mode` vaut `mono` ou `dialogue` ; en dialogue, `voices.A` / `voices.B` donnent la voix de chaque intervenant et chaque segment porte `speaker` (`A` ou `B`). Pour préparer un plan, utiliser la voix de l'intervenant du segment. Une proposition peut indiquer `speaker` (`A` ou `B`) : un nouveau segment est créé sur cet intervenant, une révision fait passer le segment sur cet intervenant. Sans `speaker`, nouveau segment sur A, révision sans changement. À l'acceptation, Capsule Studio génère avec la voix de l'intervenant définie dans le projet.

Nouveau segment (sans `segmentId`) ou révision (avec `segmentId` + `baseRevisionId` = `currentRevisionId` lu juste avant) :

```json
{
  "projectId": "PROJET_ID",
  "segmentId": "SEGMENT_ID",
  "baseRevisionId": "REVISION_ID",
  "title": "Conclusion",
  "spokenText": "Avant de modifier votre projet, gardez une copie de vos fichiers.",
  "deliveryInstruction": "[calm]",
  "requestedModelKey": "s21_free",
  "voiceId": "VOIX_LOCALE_ID",
  "speaker": "B",
  "note": "Version plus posée, comme demandé."
}
```

```bash
curl -s -X POST http://127.0.0.1:8746/api/v1/proposals \
  -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @proposition.json
```

Réponse `201` : `{ "id": "prp_…", "state": "proposed", "reviewUrl": "…" }`. **Aucun texte n'est envoyé à Fish Audio à cette étape.**

- `deliveryInstruction` est le ton de départ, placé devant le texte (`[calm]`, `[excited]`, ou une description libre en anglais). Les crochets sont ajoutés s'ils manquent : `calm` devient `[calm]`. Tout le contenu reste dans une seule balise, jamais lu à voix haute.
- Des balises peuvent aussi figurer **dans** `spokenText`, à l'endroit où elles doivent agir : `C'est fini. [break] [laughing] Enfin presque.` Liste complète des balises et conseils d'écriture (monologue, dialogue) : voir `docs/guide-balises.md`.
- `requestedModelKey` : uniquement `s21_free`, `s21_paid` ou `drama3` (clés internes, jamais un identifiant fournisseur). Seule `s21_free` est utilisable par défaut.
- Limite : 5 000 octets UTF-8 pour le texte final (indication comprise).
- `409 revision_conflict` : le segment a changé, relire le projet et reproposer.

### 3. Attendre la décision du propriétaire

```bash
curl -s http://127.0.0.1:8746/api/v1/proposals/PROPOSITION_ID -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
```

- `state` : `proposed` → `approved`, `rejected` ou `obsolete`.
- Si le propriétaire clique « Accepter et générer », `generationIds` contient l'identifiant de la génération lancée.

### 4. Suivre la génération et récupérer le fichier

```bash
curl -s http://127.0.0.1:8746/api/v1/generations/GENERATION_ID -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN"
```

États : `queued`, `running`, `succeeded`, `failed`, `uncertain`. Un plan en attente du propriétaire est `pending_approval`.

Quand `state` vaut `succeeded`, `audioUrl` est présent :

```bash
curl -s http://127.0.0.1:8746/api/v1/takes/PRISE_ID/audio -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" -o prise.wav
```

Le lien garde le contrôle d'accès : il ne fonctionne qu'avec le jeton. Format : WAV 44,1 kHz par défaut (MP3 si le propriétaire l'a choisi dans les réglages audio).

`uncertain` = la fin n'a pas pu être prouvée (coupure, erreur 5xx, redémarrage). **Ne pas relancer sans l'accord du propriétaire** : une nouvelle tentative pourrait être comptée deux fois.

### 5. (Facultatif) Préparer un plan, que le propriétaire approuve

```bash
# Plan : validation et estimation, aucun appel génératif
curl -s -X POST http://127.0.0.1:8746/api/v1/generation-plans \
  -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"segmentId":"SEGMENT_ID","revisionId":"REVISION_ID","voiceId":"VOIX_ID","modelKey":"s21_free"}'
```

Le propriétaire l'approuve dans l'interface. L'agent peut ensuite l'exécuter, avec une clé d'idempotence unique :

```bash
curl -s -X POST http://127.0.0.1:8746/api/v1/generations \
  -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: agent-$(date +%s)" \
  --data-binary '{"planId":"PLAN_ID"}'
```

- Même clé + même plan → la même génération (pas de second appel).
- Même clé + autre plan → `409`.
- Une approbation ne sert qu'une fois (`409 approval_consumed`), et expire au bout de 30 minutes.
- Plan non approuvé → `403 not_approved`.

## Mode autonome

Quand `agentAutonomy.enabled` vaut `true`, l'agent n'a plus besoin du propriétaire pour produire. Toujours interdit : modèle payant (`403 agent_paid`), création, import ou archivage de voix, archivage de projets ou de segments, réglages, budgets, jeton. Plafond quotidien propre à l'agent (`429 agent_quota`). Mode coupé : `403 autonomy_off` (repasser par les propositions).

Parcours complet d'un dialogue (corps JSON en UTF-8, via `--data-binary @fichier.json` sous Windows) :

| Étape | Appel | Corps |
|---|---|---|
| 1. Voix disponibles | `GET /api/v1/voices` | — (prendre `id` des voix à l'état `ready`) |
| 2. Créer le projet | `POST /api/v1/projects` | `{ "name": "heygen-01" }` |
| 3. Régler le dialogue | `POST /api/v1/projects/PROJET_ID/cast` | `{ "mode": "dialogue", "voices": { "A": "VOIX_A", "B": "VOIX_B" }, "names": { "A": "Alex", "B": "Sam" } }` |
| 4. Créer chaque réplique, dans l'ordre | `POST /api/v1/projects/PROJET_ID/segments` | `{ "title": "Accroche", "spokenText": "Bonjour Sam ! [laughing] Prête ?", "instruction": "[excited]", "speaker": "A" }` |
| 5. Modifier une réplique | `POST /api/v1/segments/SEGMENT_ID/revisions` | `{ "baseRevisionId": "REVISION_COURANTE", "spokenText": "…", "instruction": "[calm]" }` |
| 6. Changer l'intervenant | `POST /api/v1/segments/SEGMENT_ID/speaker` | `{ "speaker": "B" }` |
| 7. Réordonner | `POST /api/v1/segments/SEGMENT_ID/move` | `{ "direction": "up" }` ou `"down"` |
| 8. Préparer la génération | `POST /api/v1/generation-plans` | `{ "segmentId": "…", "revisionId": "…", "voiceId": "VOIX_DE_L_INTERVENANT", "modelKey": "s21_free" }` |
| 9. Approuver | `POST /api/v1/generation-plans/PLAN_ID/approve` | — |
| 10. Exécuter | `POST /api/v1/generations` + en-tête `Idempotency-Key` unique (8 à 128 caractères) | `{ "planId": "PLAN_ID" }` |
| 11. Attendre | `GET /api/v1/generations/GENERATION_ID` jusqu'à `succeeded` | — (lire `takeId`) |
| 12. Garder la prise | `POST /api/v1/segments/SEGMENT_ID/choose` | `{ "takeId": "take_…" }` |
| 13. Exporter | `POST /api/v1/exports` (ZIP `01-ALEX.wav`, `02-SAM.wav`…) ou `/api/v1/exports/wav` (un seul WAV) | `{ "takeIds": [ … ] }` |

Règles :

- Générer **un segment à la fois** (étapes 8 à 12), en attendant la fin avant le suivant.
- `voiceId` : la voix de l'intervenant du segment (`voices.A` ou `voices.B` du projet).
- `uncertain` : ne pas relancer, signaler au propriétaire.
- Le montage (`POST /api/v1/projects/PROJET_ID/montage`) est accessible, mais l'export « Répliques séparées » traité (égaliseur, coupes) n'existe que dans la page Montage du navigateur : pour un son traité, demander au propriétaire.
- Écrire les textes en suivant `docs/guide-balises.md`.

## Erreurs

Toutes les erreurs ont la forme `{ "error": { "code": "…", "message": "…" } }`. Codes utiles : `unauthenticated` (401), `forbidden` (403), `autonomy_off` / `agent_paid` (403), `not_found` (404), `revision_conflict` / `obsolete` / `stale_plan` (409), `daily_quota` / `agent_quota` (429), `model_blocked` (403), `invalid_encoding` (400).

## Export

```bash
curl -s -X POST http://127.0.0.1:8746/api/v1/exports \
  -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"takeIds":["take_…","take_…"]}' -o capsule.zip
```

ZIP des fichiers bruts nommés par réplique (`01-ALEX.wav`, `02-SAM.wav`… en dialogue, `01-titre-du-segment.wav` en monologue), prêt pour un logiciel vidéo (HeyGen…), + `manifeste.json` (ordre, intervenant, modèle demandé, intention, texte final).

Capsule assemblée en **un seul WAV** (prises WAV uniquement, dans l'ordre des segments, silence facultatif de 0 à 5000 ms) :

```bash
curl -s -X POST http://127.0.0.1:8746/api/v1/exports/wav \
  -H "Authorization: Bearer $CAPSULE_AGENT_TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"takeIds":["take_…","take_…"],"gapMs":500}' -o capsule.wav
```
