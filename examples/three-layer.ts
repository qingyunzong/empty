/**
 * Three-layer merge demo: defaults (L0) < environment (L1) < local (L2).
 *
 * Prints the merged config, then a comparison table: for every item in the
 * final config, the raw value each layer contributed, the decisive layer,
 * and the rule that explains the outcome — the folded three-layer result
 * checked against a direct per-item rule reading.
 */
import assert from 'node:assert/strict';
import {
  DELETE,
  mergeAll,
  mergeNodes,
  materialize,
  isDeleteMarker,
  isPlainObject,
  type Seg,
} from '../src/merge.js';

const L0 = {
  server: { host: '0.0.0.0', port: 8080, tls: { enabled: false } },
  features: { legacy: true },
  tags: ['base'],
  servers: [
    { id: 'web', replicas: 1, env: { DEBUG: 'false' } },
    { id: 'db', engine: 'pg', port: 5432 },
    { id: 'cache', ttl: 300 },
  ],
  limits: { cpu: '1', mem: '1Gi' },
};

const L1 = {
  server: { port: 9090, tls: { enabled: true, cert: '/etc/cert' } },
  features: { legacy: DELETE },
  tags: ['env'],
  servers: [
    { id: 'db', port: 5433 },
    { id: 'cache', $delete: true },
    { id: 'queue', workers: 2 },
  ],
  limits: 'unlimited',
};

const L2 = {
  server: { host: '127.0.0.1' },
  features: { experimental: true },
  servers: [{ id: 'web', replicas: 3 }, { id: 'ghost', $delete: true }],
};

const layers = [L0, L1, L2];
const { value, report, tombstones } = mergeAll(layers);

console.log('=== merged config (L0 defaults < L1 env < L2 local) ===');
console.log(JSON.stringify(value, null, 2));

// raw value of a layer at a path, following id-keyed array segments
function rawAt(layer: unknown, segs: Seg[]): unknown {
  let node = layer;
  for (const s of segs) {
    if (node === undefined || node === null) return undefined;
    if (typeof s === 'string') {
      if (!isPlainObject(node)) return undefined;
      node = node[s];
    } else if (typeof s === 'number') {
      if (!Array.isArray(node)) return undefined;
      node = node[s];
    } else {
      if (!Array.isArray(node)) return undefined;
      node = node.find(
        (el) => isPlainObject(el) && (el as Record<string, unknown>).id === s.id,
      );
    }
  }
  return node;
}

function show(v: unknown): string {
  if (v === undefined) return '—';
  if (isDeleteMarker(v)) return '✕ delete';
  const s = JSON.stringify(v);
  return s.length > 22 ? s.slice(0, 19) + '...' : s;
}

console.log('\n=== per-item provenance: three layers vs final, with rule ===');
const head = ['path', 'L0', 'L1', 'L2', 'final', 'src', 'rule'];
const rows = report
  .filter((e) => e.source >= 0) // items with a decisive layer
  .map((e) => [
    e.path,
    show(rawAt(L0, e.segs)),
    show(rawAt(L1, e.segs)),
    show(rawAt(L2, e.segs)),
    show(rawAt(value, e.segs)),
    `L${e.source}`,
    e.rule,
  ]);
const widths = head.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
);
const line = (cells: string[]) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

console.log('\n=== tombstones (kept internally to shadow ancestors) ===');
for (const t of tombstones) {
  console.log(`${t.path}  deleted-by=L${t.source}  rule=${t.rule}`);
}

console.log('\n=== cross-check: sequential fold vs one-shot mergeAll ===');
const leftFold = materialize(mergeNodes(mergeNodes(L0, L1), L2));
const rightFold = materialize(mergeNodes(L0, mergeNodes(L1, L2)));
assert.deepStrictEqual(leftFold, value);
assert.deepStrictEqual(rightFold, value);
console.log('merge(merge(L0,L1),L2) === merge(L0,merge(L1,L2)) === mergeAll([L0,L1,L2])  OK');

// tombstone shadows a late-arriving ancestor base
const shadowed = materialize(mergeNodes({ features: { legacy: true } }, mergeNodes(L0, mergeNodes(L1, L2))));
assert.deepStrictEqual((shadowed as Record<string, unknown>).features, { experimental: true });
console.log('tombstone for features.legacy shadows ancestor base  OK');
