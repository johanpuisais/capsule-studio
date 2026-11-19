// Palette du Studio (public/tags.js) et guide d'Hermès (docs/guide-balises.md, section 4) :
// mêmes balises et mêmes libellés français, pour que tout ce qu'écrit l'agent soit visible et compris dans l'interface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TAG_GROUPS, ALL_TAGS } from '../public/tags.js';

// Lignes de tableau « | Libellé | `[balise]` | … » de la section 4 du guide
function guideTags() {
  const md = fs.readFileSync(new URL('../docs/guide-balises.md', import.meta.url), 'utf8');
  const section = md.split(/^## 4\./m)[1].split(/^## 5\./m)[0];
  const map = new Map();
  for (const m of section.matchAll(/^\| ([^|]+?) \| `(\[[^\]]+\])` \|/gm)) map.set(m[2], m[1]);
  return map;
}

test('Balises : le guide d’Hermès et la palette du Studio contiennent exactement les mêmes balises', () => {
  const guide = guideTags();
  const palette = new Map(ALL_TAGS.map(([fr, tag]) => [tag, fr]));
  assert.ok(guide.size > 70, `section 4 du guide mal lue (${guide.size} balises)`);
  assert.deepEqual([...guide.keys()].filter((t) => !palette.has(t)), [], 'balises du guide absentes de la palette');
  assert.deepEqual([...palette.keys()].filter((t) => !guide.has(t)), [], 'balises de la palette absentes du guide');
});

test('Balises : mêmes libellés français dans le guide et la palette', () => {
  const guide = guideTags();
  const diffs = ALL_TAGS.filter(([fr, tag]) => guide.get(tag) !== fr).map(([fr, tag]) => `${tag} : palette « ${fr} » / guide « ${guide.get(tag)} »`);
  assert.deepEqual(diffs, []);
});

test('Balises : aucune balise ni libellé en double dans la palette', () => {
  const tags = ALL_TAGS.map(([, tag]) => tag);
  const labels = ALL_TAGS.map(([fr]) => fr);
  assert.equal(new Set(tags).size, tags.length, 'balise en double');
  assert.equal(new Set(labels).size, labels.length, 'libellé en double');
  for (const g of TAG_GROUPS) assert.ok(Array.isArray(g.tags) && Array.isArray(g.more), `groupe ${g.label} incomplet`);
});
