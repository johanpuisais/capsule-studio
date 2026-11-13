// Stockage privé des prises : hors du dossier public, noms générés côté serveur,
// écriture dans un fichier partiel puis renommage atomique.
import fs from 'node:fs';
import path from 'node:path';

// Prises Fish Audio (take_…) et musiques de fond envoyées par le propriétaire (music_…)
const FILE_RE = /^(take_[A-Za-z0-9_-]{6,40}\.(mp3|wav)|music_[A-Za-z0-9_-]{6,40}\.(wav|mp3|ogg|flac|m4a))$/;

export function createAudioStore(audioDir) {
  fs.mkdirSync(audioDir, { recursive: true });

  const resolve = (file) => {
    if (!FILE_RE.test(String(file))) throw new Error('Nom de fichier audio invalide.');
    const full = path.join(audioDir, file);
    if (path.dirname(full) !== path.resolve(audioDir)) throw new Error('Chemin audio refusé.');
    return full;
  };

  return {
    save(takeId, buffer, ext = 'mp3') {
      const file = `${takeId}.${ext}`;
      const full = resolve(file);
      // Une nouvelle génération ne remplace jamais un fichier existant
      if (fs.existsSync(full)) throw new Error('Fichier de prise déjà existant.');
      const partial = `${full}.partial`;
      fs.writeFileSync(partial, buffer, { flag: 'wx' });
      fs.renameSync(partial, full);
      return file;
    },
    read(file) {
      return fs.readFileSync(resolve(file));
    },
    stat(file) {
      return fs.statSync(resolve(file));
    },
    // Retrait d'une musique remplacée (les prises ne sont jamais supprimées)
    removeMusic(file) {
      if (!String(file).startsWith('music_')) throw new Error('Seule une musique peut être retirée.');
      fs.rmSync(resolve(file), { force: true });
    }
  };
}
