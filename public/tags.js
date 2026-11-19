// Liste unique des balises S2 de Capsule Studio (palette du Studio + libellés « Ton : … »).
// Elle doit rester identique à la section 4 de docs/guide-balises.md (guide d'Hermès) :
// le test tests/tags-guide.test.js échoue au moindre écart (balise ou libellé).
// Balises documentées par Fish Audio (Emotion Control), vérifiées le 2026-10-29.
//
// Chaque groupe : `tags` = boutons toujours visibles, `more` = boutons de la zone repliée « Plus de balises ».
// Format d'une balise : [libellé français, balise anglaise].
export const TAG_GROUPS = [
  {
    label: 'Émotions',
    tags: [
      ['Joyeux', '[happy]'], ['Triste', '[sad]'], ['En colère', '[angry]'], ['Enthousiaste', '[excited]'],
      ['Calme', '[calm]'], ['Nerveux', '[nervous]'], ['Confiant', '[confident]'], ['Surpris', '[surprised]'],
      ['Inquiet', '[worried]'], ['Curieux', '[curious]'], ['Sarcastique', '[sarcastic]'], ['Ému', '[moved]'],
      ['Fier', '[proud]'], ['Détendu', '[relaxed]'], ['Déterminé', '[determined]'], ['Nostalgique', '[nostalgic]'],
      ['Hésitant', '[uncertain]'], ['Déçu', '[disappointed]'], ['Méprisant', '[contemptuous]'], ['Dédaigneux', '[disdainful]'],
      ['Contrarié', '[upset]'], ['Agacé', '[frustrated]'], ['Dubitatif', '[doubtful]'], ['Perplexe', '[confused]'],
      ['Gêné', '[embarrassed]'], ['Indifférent', '[indifferent]']
    ],
    more: [
      ['Satisfait', '[satisfied]'], ['Ravi', '[delighted]'], ['Effrayé', '[scared]'], ['Déprimé', '[depressed]'],
      ['Empathique', '[empathetic]'], ['Dégoûté', '[disgusted]'], ['Reconnaissant', '[grateful]'], ['Malheureux', '[unhappy]'],
      ['Anxieux', '[anxious]'], ['Hystérique', '[hysterical]'], ['Plein de regrets', '[regretful]'], ['Coupable', '[guilty]'],
      ['Honteux', '[ashamed]'], ['Jaloux', '[jealous]'], ['Envieux', '[envious]'], ['Plein d’espoir', '[hopeful]'],
      ['Optimiste', '[optimistic]'], ['Pessimiste', '[pessimistic]'], ['Seul, mélancolique', '[lonely]'], ['Blasé, ennuyé', '[bored]'],
      ['Compatissant', '[sympathetic]'], ['Bienveillant', '[compassionate]'], ['Résigné', '[resigned]']
    ]
  },
  {
    label: 'Ton',
    tags: [['Chuchoté', '[whispering]'], ['Voix douce', '[soft tone]'], ['Pressé', '[in a hurry tone]'], ['Crié', '[shouting]'], ['Insistance', '[emphasis]']],
    more: [['Hurlé', '[screaming]']]
  },
  // Descriptions libres acceptées par S2 mais sans balise documentée : rendu non garanti
  {
    label: 'Libres', free: true,
    tags: [['Interrogatif', '[questioning tone]'], ['Vexé', '[offended]'], ['Choqué', '[shocked]'], ['Moqueur', '[mocking]']],
    more: []
  },
  {
    label: 'Sons',
    tags: [['Rire', '[laughing]'], ['Petit rire', '[chuckling]'], ['Soupir', '[sighing]'], ['Souffle coupé', '[gasping]'], ['Raclement de gorge', '[clear throat]'], ['Bâillement', '[yawning]']],
    more: [['Sanglot', '[sobbing]'], ['Pleurs', '[crying loudly]'], ['Grognement, gémissement', '[groaning]'], ['Essoufflement', '[panting]'], ['Ronflement', '[snoring]']]
  },
  {
    label: 'Ambiance',
    tags: [],
    more: [['Rires du public', '[audience laughing]'], ['Rires en fond', '[background laughter]'], ['Rires de foule', '[crowd laughing]']]
  },
  { label: 'Pauses', tags: [['Pause', '[break]'], ['Longue pause', '[long-break]']], more: [] }
];

// Toutes les balises, visibles ou repliées : [libellé, balise, nom du groupe]
export const ALL_TAGS = TAG_GROUPS.flatMap((g) => [...g.tags, ...g.more].map(([fr, tag]) => [fr, tag, g.label]));
