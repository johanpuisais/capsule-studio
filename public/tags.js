// Liste unique des balises S2 de Capsule Studio (palette du Studio + libellés « Ton : … »).
// Elle doit rester identique à la section 4 de docs/guide-balises.md (guide d'Hermès) :
// le test tests/tags-guide.test.js échoue au moindre écart (balise ou libellé).
// Balises documentées par Fish Audio (Emotion Control), vérifiées le 2026-10-29.
//
// Les émotions sont rangées par familles, chacune avec sa couleur (`fam`, voir --fam-* dans styles.css).
// Chaque groupe : `tags` = boutons toujours visibles, `more` = boutons affichés par le bouton « +N » du groupe
// (et toujours trouvés par la recherche).
// Format d'une balise : [libellé français, balise anglaise].
export const TAG_GROUPS = [
  {
    label: 'Joie et assurance', fam: 'joie',
    tags: [['Joyeux', '[happy]'], ['Enthousiaste', '[excited]'], ['Ravi', '[delighted]'], ['Confiant', '[confident]'], ['Satisfait', '[satisfied]']],
    more: [['Fier', '[proud]'], ['Déterminé', '[determined]'], ['Reconnaissant', '[grateful]'], ['Plein d’espoir', '[hopeful]'], ['Optimiste', '[optimistic]']]
  },
  {
    label: 'Calme et tendresse', fam: 'calme',
    tags: [['Calme', '[calm]'], ['Détendu', '[relaxed]'], ['Ému', '[moved]'], ['Empathique', '[empathetic]']],
    more: [['Nostalgique', '[nostalgic]'], ['Compatissant', '[sympathetic]'], ['Bienveillant', '[compassionate]']]
  },
  {
    label: 'Surprise et doute', fam: 'surprise',
    tags: [['Surpris', '[surprised]'], ['Curieux', '[curious]'], ['Perplexe', '[confused]'], ['Hésitant', '[uncertain]'], ['Dubitatif', '[doubtful]']],
    more: []
  },
  {
    label: 'Tristesse et lassitude', fam: 'tristesse',
    tags: [['Triste', '[sad]'], ['Déçu', '[disappointed]'], ['Blasé, ennuyé', '[bored]'], ['Résigné', '[resigned]']],
    more: [['Malheureux', '[unhappy]'], ['Déprimé', '[depressed]'], ['Seul, mélancolique', '[lonely]'], ['Plein de regrets', '[regretful]'], ['Pessimiste', '[pessimistic]'], ['Indifférent', '[indifferent]']]
  },
  {
    label: 'Peur et gêne', fam: 'peur',
    tags: [['Nerveux', '[nervous]'], ['Inquiet', '[worried]'], ['Effrayé', '[scared]'], ['Gêné', '[embarrassed]']],
    more: [['Anxieux', '[anxious]'], ['Hystérique', '[hysterical]'], ['Coupable', '[guilty]'], ['Honteux', '[ashamed]']]
  },
  {
    label: 'Colère et ironie', fam: 'colere',
    tags: [['En colère', '[angry]'], ['Agacé', '[frustrated]'], ['Contrarié', '[upset]'], ['Sarcastique', '[sarcastic]']],
    more: [['Méprisant', '[contemptuous]'], ['Dédaigneux', '[disdainful]'], ['Dégoûté', '[disgusted]'], ['Jaloux', '[jealous]'], ['Envieux', '[envious]']]
  },
  {
    label: 'Ton', fam: 'ton',
    tags: [['Chuchoté', '[whispering]'], ['Voix douce', '[soft tone]'], ['Insistance', '[emphasis]'], ['Pressé', '[in a hurry tone]'], ['Crié', '[shouting]']],
    more: [['Hurlé', '[screaming]']]
  },
  // Descriptions libres acceptées par S2 mais sans balise documentée : rendu non garanti
  {
    label: 'Libres', fam: 'ton', free: true,
    tags: [['Interrogatif', '[questioning tone]'], ['Vexé', '[offended]'], ['Choqué', '[shocked]'], ['Moqueur', '[mocking]']],
    more: []
  },
  {
    label: 'Sons et ambiance', fam: 'sons',
    tags: [['Rire', '[laughing]'], ['Petit rire', '[chuckling]'], ['Soupir', '[sighing]'], ['Souffle coupé', '[gasping]'], ['Raclement de gorge', '[clear throat]']],
    more: [
      ['Bâillement', '[yawning]'], ['Sanglot', '[sobbing]'], ['Pleurs', '[crying loudly]'], ['Grognement, gémissement', '[groaning]'],
      ['Essoufflement', '[panting]'], ['Ronflement', '[snoring]'],
      ['Rires du public', '[audience laughing]'], ['Rires en fond', '[background laughter]'], ['Rires de foule', '[crowd laughing]']
    ]
  },
  { label: 'Pauses', fam: 'pause', tags: [['Pause', '[break]'], ['Longue pause', '[long-break]']], more: [] }
];

// Toutes les balises, visibles ou repliées : [libellé, balise, nom du groupe]
export const ALL_TAGS = TAG_GROUPS.flatMap((g) => [...g.tags, ...g.more].map(([fr, tag]) => [fr, tag, g.label]));

// Recherche sans accents ni majuscules (« deçu » = « Déçu »)
export const searchKey = (s) => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
