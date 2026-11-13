# Guide Hermès : écrire un monologue ou un dialogue vivant avec les balises

Ce guide complète `docs/AGENT-USAGE.md` (accès, API, propositions). Il explique **comment écrire** un texte que Fish Audio S2 dira de façon naturelle et expressive dans Capsule Studio, en monologue (une voix) ou en dialogue (deux voix A/B).

Balises vérifiées sur la documentation Fish Audio (Emotion Control) le 2026-10-29.

---

## 1. Les deux façons de livrer un texte au propriétaire

| Besoin | Méthode | Pourquoi |
|---|---|---|
| Mode autonome activé par le propriétaire | **Créer le projet et les segments soi-même** via l'API (voir « Mode autonome » dans `AGENT-USAGE.md`) | Les règles d'écriture de ce guide s'appliquent à chaque `spokenText` ; une balise en tête va dans `instruction`. |
| Un monologue ou un dialogue complet | **Un script `.md` ou `.txt`** au format d'import (section 2) | Le propriétaire l'importe en un clic (« ↑ Importer un script ») : un paragraphe = un segment, intervenants A/B attribués automatiquement. |
| Retoucher ou ajouter un segment isolé (monologue ou dialogue) | **Une proposition** via `POST /api/v1/proposals` (voir `AGENT-USAGE.md`) | Le propriétaire accepte ou refuse dans l'interface. |

En dialogue, une proposition précise l'intervenant avec `"speaker": "A"` ou `"speaker": "B"`. Sans ce champ, un nouveau segment va sur **A** et une révision garde l'intervenant actuel du segment. Pour un dialogue entier, le script reste plus rapide pour le propriétaire (un seul import au lieu d'une validation par réplique).

---

## 2. Format du script à importer

### Règles

- **Une ligne vide entre deux paragraphes** : chaque paragraphe devient un segment (une génération).
- **Dialogue** : chaque réplique commence par le nom de l'intervenant **en majuscules** suivi de `:`. Le premier nom rencontré devient A, le second B. **Deux intervenants au maximum.**
- **Monologue** : pas de nom en tête, simplement des paragraphes.
- Les lignes de titre Markdown (`# …`) sont **supprimées à l'import** dans un fichier `.md` : on peut s'en servir pour structurer le script ou laisser des notes au propriétaire, elles ne seront jamais lues.
- Les balises entre crochets sont conservées telles quelles.
- Limite : environ 4 700 octets par paragraphe (5 000 moins une marge pour le ton de départ). Un paragraphe trop long est découpé automatiquement, mais mieux vaut viser **1 à 4 phrases par paragraphe** : les prises sont plus faciles à refaire une par une.
- Le texte parlé ne contient **ni Markdown (gras, listes), ni émojis, ni liens** : tout ce qui n'est pas entre crochets est lu à voix haute.

### Exemple de monologue

```markdown
# Accroche (note : ton complice, rythme rapide)

[excited] Vous perdez des heures à monter vos vidéos ? [break] Moi aussi. Enfin… jusqu'à la semaine dernière.

# Le problème

[sighing] Le montage, c'est le moment où tout ralentit. [slightly frustrated] On coupe, on recoupe, on cherche le bon plan…

[confident] Aujourd'hui, je vous montre une méthode qui divise ce temps par deux. [emphasis] Par deux.
```

### Exemple de dialogue

```markdown
# Ouverture

ALEX: [excited] Bienvenue dans ce nouvel épisode ! Aujourd'hui, on parle d'intelligence artificielle… [break] et Sam n'est pas d'accord avec moi.

SAM: [chuckling] Pas d'accord, c'est un grand mot. [doubtful] Disons que j'ai quelques questions.

ALEX: [curious] Vas-y, je t'écoute.

SAM: [questioning tone] Tu es vraiment sûr qu'on peut lui confier un script entier ?

ALEX: [laughing] Bon. [long-break] [calm] Non. Pas sans relire.
```

---

## 3. Où placer une balise

- **Ton de départ** : la balise placée tout au début du paragraphe (après le nom en dialogue) devient, à l'import, le « Ton de départ » du segment dans Capsule Studio. Elle donne le ton général ; le propriétaire peut la changer d'un clic.
- **Dans le texte** : une balise agit **sur ce qui la suit**, jusqu'à la balise suivante. La placer juste **avant** les mots concernés : `C'était prévu. [sad] Mais rien ne s'est passé comme prévu.`
- **Sons** : à l'endroit exact où le son doit se produire : `Et là… [laughing] il est tombé.`
- **Intensité** : on peut nuancer en anglais : `[slightly sad]`, `[very excited]`, `[a bit nervous]`.
- **Combiner** : deux balises côte à côte sont possibles (`[whispering] [nervous]`), au-delà le rendu devient imprévisible.
- Les balises sont **toujours en anglais**, entre crochets droits `[ ]`. Les parenthèses `( )` sont l'ancien format S1, à ne pas utiliser.

---

## 4. Liste complète des balises

### Émotions de base (documentées)

| Français | Balise |
|---|---|
| Joyeux | `[happy]` |
| Triste | `[sad]` |
| En colère | `[angry]` |
| Enthousiaste | `[excited]` |
| Calme | `[calm]` |
| Nerveux | `[nervous]` |
| Confiant | `[confident]` |
| Surpris, choqué | `[surprised]` |
| Satisfait | `[satisfied]` |
| Ravi | `[delighted]` |
| Effrayé | `[scared]` |
| Inquiet | `[worried]` |
| Contrarié, vexé | `[upset]` |
| Agacé, frustré | `[frustrated]` |
| Déprimé | `[depressed]` |
| Empathique | `[empathetic]` |
| Gêné | `[embarrassed]` |
| Dégoûté | `[disgusted]` |
| Ému | `[moved]` |
| Fier | `[proud]` |
| Détendu | `[relaxed]` |
| Reconnaissant | `[grateful]` |
| Curieux | `[curious]` |
| Sarcastique, ironique | `[sarcastic]` |

### Émotions avancées (documentées)

| Français | Balise |
|---|---|
| Dédaigneux | `[disdainful]` |
| Méprisant | `[contemptuous]` |
| Malheureux | `[unhappy]` |
| Anxieux | `[anxious]` |
| Hystérique | `[hysterical]` |
| Indifférent | `[indifferent]` |
| Hésitant | `[uncertain]` |
| Dubitatif | `[doubtful]` |
| Perplexe | `[confused]` |
| Déçu | `[disappointed]` |
| Plein de regrets | `[regretful]` |
| Coupable | `[guilty]` |
| Honteux | `[ashamed]` |
| Jaloux | `[jealous]` |
| Envieux | `[envious]` |
| Plein d'espoir | `[hopeful]` |
| Optimiste | `[optimistic]` |
| Pessimiste | `[pessimistic]` |
| Nostalgique | `[nostalgic]` |
| Seul, mélancolique | `[lonely]` |
| Blasé, ennuyé | `[bored]` |
| Compatissant | `[sympathetic]` |
| Bienveillant | `[compassionate]` |
| Déterminé | `[determined]` |
| Résigné | `[resigned]` |

### Tons (documentés)

| Français | Balise |
|---|---|
| Pressé | `[in a hurry tone]` |
| Crié | `[shouting]` |
| Hurlé | `[screaming]` |
| Chuchoté | `[whispering]` |
| Voix douce | `[soft tone]` |
| Insistance | `[emphasis]` |

### Sons (documentés)

| Français | Balise |
|---|---|
| Rire | `[laughing]` |
| Petit rire | `[chuckling]` |
| Sanglot | `[sobbing]` |
| Pleurs | `[crying loudly]` |
| Soupir | `[sighing]` |
| Grognement, gémissement | `[groaning]` |
| Essoufflement | `[panting]` |
| Souffle coupé | `[gasping]` |
| Bâillement | `[yawning]` |
| Ronflement | `[snoring]` |
| Raclement de gorge | `[clear throat]` |

### Ambiance (documentées)

| Français | Balise |
|---|---|
| Rires du public | `[audience laughing]` |
| Rires en fond | `[background laughter]` |
| Rires de foule | `[crowd laughing]` |

### Pauses (documentées)

| Français | Balise |
|---|---|
| Pause courte | `[break]` |
| Pause longue | `[long-break]` |

### Descriptions libres (non documentées, rendu non garanti)

S2 accepte des descriptions en anglais libre entre crochets. Celles-ci sont proposées dans la palette de Capsule Studio, à **valider à l'écoute** :

| Français | Balise | Repli documenté si le rendu est faible |
|---|---|---|
| Interrogatif | `[questioning tone]` | `[curious]` ou `[doubtful]` |
| Vexé | `[offended]` | `[upset]` |
| Choqué | `[shocked]` | `[surprised]` |
| Moqueur | `[mocking]` | `[sarcastic]` |

D'autres descriptions courtes sont possibles (`[friendly]`, `[mysterious]`, `[urgent]`, `[serious]`…). Règle : **deux ou trois mots anglais au maximum**, et le signaler au propriétaire dans une ligne de titre `#` pour qu'il vérifie le rendu.

---

## 5. Rendre la génération vivante

### Écrire pour l'oreille

- **Écrire comme on parle** : phrases courtes, sujet-verbe-complément, une idée par phrase. Alterner phrases longues et très courtes : « Ça marche. Vraiment. »
- **Ponctuation = respiration** : la virgule fait une micro-pause, le point une pause, les points de suspension `…` une hésitation ou un suspense, le point d'exclamation de l'énergie, le point d'interrogation une **vraie intonation montante** (souvent suffisant sans balise).
- **Interjections et relances** : « Bon. », « Alors… », « Attendez. », « Vous voyez ? », « Hein ? », « Eh bien… ». Elles cassent la lecture monotone.
- **Nombres, sigles et symboles en toutes lettres** quand la lecture est ambiguë : « deux mille vingt-six », « vingt pour cent », « I-A » ou « intelligence artificielle ».
- **Mots étrangers** : les écrire comme ils doivent sonner s'ils sont mal prononcés, et le signaler au propriétaire.

### Doser les balises

- **Une balise d'émotion par phrase ou deux, au maximum** (environ une pour 15 à 25 mots). Trop de balises = voix instable.
- **Faire évoluer l'émotion** au fil du texte : un segment entier au même ton sonne plat. Exemple d'arc : `[curious]` → `[surprised]` → `[confident]`.
- **Sons avec parcimonie** : un rire ou un soupir par paragraphe au plus, là où un humain le ferait vraiment.
- **Pauses** : `[break]` avant une révélation, une chute, une question importante ; `[long-break]` rarement (changement de sujet, effet dramatique).
- **Contraste** : une phrase `[whispering]` ou `[soft tone]` après un passage énergique attire l'attention ; `[emphasis]` sur un mot clé, pas sur une phrase entière.
- Ne jamais mettre de balise **au milieu d'un mot** ni entre un article et son nom.

### Spécifique au dialogue

- **Répliques courtes et alternées** : 1 à 3 phrases par réplique. Un monologue déguisé en dialogue sonne faux.
- **Réactions** : faire réagir l'autre avant qu'il ne réponde (`SAM: [chuckling] Sérieusement ?`).
- **Désaccords et relances** : un dialogue vivant a des frottements (doute, objection, taquinerie), pas seulement des approbations.
- **Interruption** : couper une réplique avec `…` puis faire entrer l'autre ; le propriétaire peut ensuite faire chevaucher les deux segments dans la page Montage.
- **Prénoms** : les personnages s'appellent par leur prénom de temps en temps, comme dans une vraie conversation.
- **Un intervenant par paragraphe**, toujours. Jamais deux voix dans le même segment.

### Erreurs à éviter

- Balise en français (`[joyeux]`) : non reconnue, risque d'être lue à voix haute.
- Balise entre parenthèses ou accolades : ancien format ou texte lu.
- Didascalies hors crochets (« *il rit* ») : lues à voix haute.
- Paragraphe de 15 phrases : une seule prise ratée oblige à tout refaire.
- Même ton de départ sur tous les segments : rendu monotone.

---

## 6. Checklist avant de livrer le script

1. Une ligne vide entre chaque paragraphe.
2. Dialogue : noms en majuscules suivis de `:`, deux intervenants maximum.
3. Toutes les balises en anglais, entre crochets `[ ]`, issues de la liste ci-dessus (ou signalées comme libres).
4. Pas plus d'une balise d'émotion par phrase ou deux ; au moins un changement d'émotion par segment long.
5. Aucun Markdown, émoji ou lien dans le texte parlé ; les notes pour le propriétaire sont sur des lignes `#`.
6. Nombres et sigles écrits comme ils doivent être prononcés.
7. Relecture à voix haute : si une phrase est difficile à dire d'une traite, la couper.
