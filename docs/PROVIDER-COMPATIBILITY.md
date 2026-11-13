# Compatibilité Fish Audio

Vérifications faites le **22 octobre 2026** sur la documentation publique. Aucun appel génératif n'a été fait pour les établir.

## Sources consultées

| Source | URL |
|---|---|
| Schéma OpenAPI | https://api.fish.audio/openapi.json |
| Référence TTS | https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech |
| Tarifs et limites | https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits |
| Offre S2.1 Pro Free | https://fish.audio/blog/s2-1-pro-free-api |
| Création de voix | https://docs.fish.audio/api-reference/endpoint/model/create-model |

## Modèles

| Clé interne | Identifiant envoyé (`model`) | Tarif relevé | État dans l'application |
|---|---|---|---|
| `s21_free` | `s2.1-pro-free` | 0 $ / M octets UTF-8 | Par défaut, utilisable jusqu'au 30/11/2026 (Europe/Paris) |
| `s21_paid` | `s2.1-pro` | 15 $ / M octets UTF-8 | Désactivé par défaut (Réglages → Générations payantes) |
| `drama3` | `drama-3` | 50 $ / M octets UTF-8 (promo 10 $ jusqu'au 12/11/2026 17:00 UTC) | Désactivé par défaut (Réglages → Générations payantes) |

- **Point critique** : le schéma OpenAPI indique qu'un en-tête `model` **absent ou inconnu retombe sur `s2.1-pro` (payant)**. L'application envoie donc toujours `model` explicitement, depuis un registre fermé côté serveur, sans correction ni essai d'identifiant.
- **Drama 3 : ambiguïté du 14/10 résolue.** Le cahier des charges signalait `drama-3-preview` (page TTS) contre `drama-3` (OpenAPI). Le 22/10, les deux sources indiquent `drama-3`, et la grille tarifaire publie son prix. Drama 3 reste néanmoins bloqué : il est payant et non testé en réel. L'estimation utilise le prix catalogue (50 $), pas la promotion.
- L'API ne renvoie pas le modèle réellement servi : l'application affiche « modèle demandé » et `providerReportedModel` reste `null`.

## Offre gratuite

Billet officiel (22/10/2026) : « Free access is available through November 30, 2026 », sous Fair Use Policy, sans SLA ni garantie de latence. Les requêtes peuvent servir à améliorer les modèles : n'envoyer que des textes non confidentiels.

Le fuseau `Europe/Paris` est une règle de l'application (fin de journée locale), pas une heure contractuelle annoncée par Fish Audio.

## Appel TTS utilisé

`POST https://api.fish.audio/v1/tts`, JSON, en-têtes `Authorization: Bearer …`, `Content-Type: application/json`, `model: …`.

Corps envoyé (liste fermée) : `text`, `reference_id`, `format: "mp3"`, `mp3_bitrate: 128`, `sample_rate: 44100`, `latency: "normal"`. Les autres paramètres (température, normalisation…) gardent les valeurs par défaut de Fish Audio.

Fréquences d'échantillonnage acceptées par Fish Audio en WAV (d'après la réponse 400 de l'API, constatée le 2026-10-23) : 8000, 16000, 24000, 32000, 44100 Hz. Le 48 kHz est refusé ; l'application n'utilise que 44100 Hz (les fréquences inférieures dégradent la qualité). Conversion en 48 kHz à faire au montage si besoin.

Le schéma ne propose pas de paramètre de canaux : la sortie mono n'est donc pas imposée par l'application. Le nombre de canaux réel est lu dans le MP3 reçu et affiché.

Réponses documentées : 200 (flux audio), 401, 402, 503. Le 429 est géré en plus (reprise bornée).

## Création de voix

`POST https://api.fish.audio/model`, `multipart/form-data` : `type=tts`, `title`, `train_mode=fast`, `visibility=private`, `voices` (fichier), `texts` (si transcription fournie), `generate_sample=false`, `enhance_audio_quality` explicite (**`false` par défaut** ; la valeur par défaut de Fish Audio est `true`).

Sans `texts`, Fish Audio transcrit automatiquement l'échantillon. Ce qu'on sait du coût :
- le billet de l'offre indique « Voice cloning is available on the free tier, subject to the same Fair Use Policy » ;
- la grille ne publie aucun prix de création de voix ;
- elle facture la transcription (ASR) à 0,36 $ par heure d'audio pour ses endpoints dédiés, sans préciser si la transcription automatique du clonage est facturée.

Pour lever le doute, **fournir la transcription** de l'échantillon. La grille précise aussi que les erreurs d'authentification, de validation, de solde, de concurrence et de service ne sont pas facturées.

Après création, la voix est relue (`GET /model/{id}`) : `type`, `state`, `visibility`, `dmca_taken_down`, `takedown_category`. « Prête » seulement si `state=trained` et `visibility=private`.

## Non pris en charge en V1

Streaming temps réel, multi-locuteur, références inline (MessagePack), Voice Design, MCP officiel Fish Audio, inpainting Drama 3.
