import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph } from '../src/graph.js';
import { parseSource } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { execute } from '../src/vm.js';
import { verifyCertificate } from '../src/cert.js';

const attrs = (type) => ({ type, date: '2025-01-01', name: type });

function fixture() {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', attrs: attrs('raw') },
    { op: 'add', id: 'LOT-2025-0002', attrs: attrs('semi') },
    { op: 'add', id: 'LOT-2025-0003', attrs: attrs('finished') },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  const { certificates } = execute(
    compile(parseSource('query ancestors(LOT-2025-0003);')),
    g,
  );
  return { graph: g, cert: certificates[0] };
}

test('a genuine certificate verifies, with and without the graph state', () => {
  const { graph, cert } = fixture();
  assert.deepEqual(verifyCertificate(cert), { ok: true, errors: [] });
  assert.deepEqual(verifyCertificate(cert, graph.toJSON()), { ok: true, errors: [] });
});

test('acceptance 5: tampering with a path fails verification', () => {
  const { graph, cert } = fixture();
  const tampered = structuredClone(cert);
  tampered.paths[0][0] = 'LOT-2025-0099';
  const result = verifyCertificate(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /path 0 hash mismatch/.test(e)));
  const withState = verifyCertificate(tampered, graph.toJSON());
  assert.equal(withState.ok, false);
});

test('tampering with the result or the hash fails verification', () => {
  const { cert } = fixture();
  const badResult = structuredClone(cert);
  badResult.result = ['LOT-2025-0001'];
  assert.equal(verifyCertificate(badResult).ok, false);

  const badHash = structuredClone(cert);
  badHash.hash = '0'.repeat(64);
  assert.equal(verifyCertificate(badHash).ok, false);
});

test('a certificate from a stale graph version fails against the current state', () => {
  const { graph, cert } = fixture();
  graph.applyTransaction([{ op: 'unlink', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  const result = verifyCertificate(cert, graph.toJSON());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /version mismatch/.test(e)));
});

test('missing fields are reported', () => {
  const result = verifyCertificate({ query: 'query x;' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /missing field 'hash'/.test(e)));
});

test('certificates over let variables re-execute the full program', () => {
  const { graph } = fixture();
  const source =
    'let up = ancestors(LOT-2025-0003);\nquery up where type == "raw";';
  const { certificates } = execute(compile(parseSource(source)), graph, source);
  const cert = certificates[0];
  assert.equal(cert.statementIndex, 0);
  assert.deepEqual(verifyCertificate(cert, graph.toJSON()), { ok: true, errors: [] });
  const tampered = structuredClone(cert);
  tampered.program = tampered.program.replace('"raw"', '"semi"');
  assert.equal(verifyCertificate(tampered, graph.toJSON()).ok, false);
});
