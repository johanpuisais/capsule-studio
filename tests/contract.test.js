// Le contrat docs/api-contract.yaml correspond exactement aux routes implémentées
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../src/config.js';
import { makeApp } from './helpers.js';

test('contrat API : mêmes routes, mêmes méthodes, mêmes droits agent (y compris mode autonome)', () => {
  const yaml = fs.readFileSync(path.join(APP_ROOT, 'docs', 'api-contract.yaml'), 'utf8');
  const documented = new Map();
  const autonomousDoc = new Map();
  let current = null;
  for (const line of yaml.split(/\r?\n/)) {
    const p = line.match(/^ {2}(\/api\/\S+):\s*$/);
    if (p) { current = p[1]; continue; }
    const m = line.match(/^ {4}(get|post):\s*(.*)$/);
    if (m && current) {
      documented.set(`${m[1].toUpperCase()} ${current}`, /x-agent: true/.test(m[2]));
      autonomousDoc.set(`${m[1].toUpperCase()} ${current}`, /x-autonomous: true/.test(m[2]));
    }
  }
  const { app } = makeApp();
  const implemented = new Map(app.routes().map((r) => [`${r.method} ${r.path}`, r.agent]));
  assert.deepEqual([...documented.keys()].sort(), [...implemented.keys()].sort());
  for (const [k, agent] of implemented) assert.equal(documented.get(k), agent, `droit agent : ${k}`);
  for (const r of app.routes()) assert.equal(autonomousDoc.get(`${r.method} ${r.path}`), r.autonomous, `mode autonome : ${r.method} ${r.path}`);
});
