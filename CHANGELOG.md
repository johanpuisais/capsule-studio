# Journal des versions

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), numérotation [SemVer](https://semver.org/lang/fr/).

## [1.0.0] - 2026-11

Première version publique.

### Studio
- Segments de texte, balises d'émotion en français (palette et saisie dans le texte), prises multiples, comparaison et choix de la meilleure prise.
- Import d'un script `.txt` ou `.md`, « Tout générer » en un clic.
- Dialogue A/B : deux voix par projet, import `ALEX: … / SAM: …`.

### Voix
- Clonage privé (consentement obligatoire), import des voix du compte Fish Audio, catalogue filtrable avec écoute.

### Montage
- Une piste par voix : volume, égaliseur 3 bandes, compresseur, pièce (réverbération), muet et solo, limiteur général.
- Décalages et chevauchements à la souris, coupes, blancs raccourcis automatiquement.
- Musique de fond : baisse sous les voix, fondus, boucle.
- Exports : WAV unique, ZIP des prises nommées par réplique, répliques traitées séparées avec `repliques.csv`.

### Agent IA
- Jeton séparé, propositions validées par le propriétaire, mode autonome facultatif avec plafond quotidien.

### Réglages et installation
- Clé Fish Audio saisie dans l'application, vérifiée avant enregistrement, jamais renvoyée au navigateur.
- Générations payantes, budgets, Drama 3, limite quotidienne, date de fin de l'offre gratuite et réseau local réglables dans l'application ; fichier `.env` facultatif.
- Données dans le dossier de l'utilisateur (`%APPDATA%\CapsuleStudio` sous Windows) : les mises à jour ne les touchent pas.
- ZIP portable Windows avec Node.js inclus.
