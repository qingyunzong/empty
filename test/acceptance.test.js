import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineageGraph } from '../src/graph.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { issueCertificate, verifyCertificate } from '../src/cert.js';
import { main } from '../src/cli.js';

const query = (g, src) => run(compile(parse(src)), g);

// ---------- ① shared raw material: dedup + deterministic order ----------
test('acceptance 1: two intermediates share one raw material; ancestors deduped and ordered', () => {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material' },
    { op: 'add', id: 'LOT-2025-0002', type: 'intermediate' },
    { op: 'add', id: 'LOT-2025-0003', type: 'intermediate' },
    { op: 'add', id: 'LOT-2025-0004', type: 'product' },
  ]);
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' }, // shared raw material
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0004' },
    { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0004' },
  ]);
  const [out] = query(g, 'ancestors(LOT-2025-0004);');
  assert.deepEqual(out.ids, ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0003']);
  assert.equal(new Set(out.ids).size, out.ids.length, 'no duplicates');
  const again = query(g, 'ancestors(LOT-2025-0004);')[0];
  assert.deepEqual(again.ids, out.ids, 'deterministic order across runs');
});

// ---------- ② undo restores lineage; redo yields a different cert version ----------
test('acceptance 2: undo of wrong link restores lineage; redo changes certificate version', () => {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material' },
    { op: 'add', id: 'LOT-2025-0002', type: 'raw_material' },
    { op: 'add', id: 'LOT-2025-0003', type: 'product' },
  ]);
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' }]);
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' }]); // wrong entry

  const certOf = () => issueCertificate({
    querySource: 'ancestors(LOT-2025-0003);', graph: g, results: query(g, 'ancestors(LOT-2025-0003);'),
  });

  g.undo(); // retract the wrong link
  let [out] = query(g, 'ancestors(LOT-2025-0003);');
  assert.deepEqual(out.ids, ['LOT-2025-0001'], 'lineage restored after undo');
  const certAfterUndo = certOf();

  g.redo(); // re-apply the link
  [out] = query(g, 'ancestors(LOT-2025-0003);');
  assert.deepEqual(out.ids, ['LOT-2025-0001', 'LOT-2025-0002']);
  const certAfterRedo = certOf();
  assert.notEqual(certAfterUndo.graphVersion, certAfterRedo.graphVersion,
    'certificate graph version differs after redo');
  assert.ok(verifyCertificate(certAfterUndo).ok);
  assert.ok(verifyCertificate(certAfterRedo).ok);
});

// ---------- ③ cycle rejected, no partial write ----------
test('acceptance 3: cycle-forming command rejected, transaction fully rolled back', () => {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material' },
    { op: 'add', id: 'LOT-2025-0002', type: 'intermediate' },
    { op: 'add', id: 'LOT-2025-0003', type: 'intermediate' },
    { op: 'add', id: 'LOT-2025-0004', type: 'product' },
  ]);
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  const snapshot = JSON.stringify(g.toJSON());
  const version = g.version;
  assert.throws(() => g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0004' }, // valid, would persist on partial write
    { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0002' }, // cycle!
  ]), /cycle/);
  assert.equal(JSON.stringify(g.toJSON()), snapshot, 'no partial write');
  assert.equal(g.version, version, 'version unchanged');
  assert.deepEqual(g.successors('LOT-2025-0003'), [], 'first command of failed tx not persisted');
});

// ---------- ④ random graphs (<=30 nodes) vs independent BFS reference ----------
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function refBfs(nodes, edges, starts, forward) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) adj.get(forward ? a : b).push(forward ? b : a);
  const seen = new Set(starts);
  const out = [];
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of adj.get(cur)) {
      if (!seen.has(nxt)) { seen.add(nxt); out.push(nxt); queue.push(nxt); }
    }
  }
  return out.sort();
}

function refShortest(edges, from, to) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const [a, b] of edges) {
      if (a === cur && !prev.has(b)) { prev.set(b, cur); queue.push(b); }
    }
  }
  if (!prev.has(to)) return [];
  const path = [];
  for (let p = to; p !== null; p = prev.get(p)) path.unshift(p);
  return path;
}

test('acceptance 4: random <=30-node graphs match independent BFS reference', () => {
  for (const seed of [1, 7, 42, 1337, 2025]) {
    const rand = lcg(seed);
    const g = new LineageGraph();
    const groups = ['raw_material', 'intermediate', 'product'];
    const ids = [];
    const addCmds = [];
    for (let i = 0; i < 30; i++) {
      const id = `LOT-2025-${String(i + 1).padStart(4, '0')}`;
      ids.push(id);
      addCmds.push({ op: 'add', id, type: groups[Math.floor(i / 10)] });
    }
    g.applyTransaction(addCmds);
    const edges = [];
    const linkCmds = [];
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        const gi = Math.floor(i / 10);
        const gj = Math.floor(j / 10);
        if (gj > gi && rand() < 0.12) { // only flows raw -> intermediate -> product: always a DAG
          edges.push([ids[i], ids[j]]);
          linkCmds.push({ op: 'link', from: ids[i], to: ids[j] });
        }
      }
    }
    g.applyTransaction(linkCmds);

    for (const id of ids) {
      assert.deepEqual([...g.ancestorsOf([id])].sort(), refBfs(ids, edges, [id], false),
        `ancestors(${id}) seed=${seed}`);
      assert.deepEqual([...g.descendantsOf([id])].sort(), refBfs(ids, edges, [id], true),
        `descendants(${id}) seed=${seed}`);
    }
    for (let k = 0; k < 20; k++) {
      const a = ids[Math.floor(rand() * 30)];
      const b = ids[Math.floor(rand() * 30)];
      assert.deepEqual(g.shortestPath(a, b), refShortest(edges, a, b),
        `shortestPath(${a},${b}) seed=${seed}`);
    }
  }
});

// ---------- ⑤ tampered path fails verification ----------
test('acceptance 5: tampering with a path makes verification fail', () => {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material' },
    { op: 'add', id: 'LOT-2025-0002', type: 'intermediate' },
    { op: 'add', id: 'LOT-2025-0003', type: 'product' },
  ]);
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  const src = 'shortestPath(LOT-2025-0001, LOT-2025-0003);';
  const cert = issueCertificate({ querySource: src, graph: g, results: query(g, src) });
  assert.ok(verifyCertificate(cert).ok, 'honest certificate verifies');

  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.results[0].nodes[1] = 'LOT-2025-0009'; // swap in a fake path node
  const verdict = verifyCertificate(tampered);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('path 0')), 'path tampering detected');

  const tamperedCmds = JSON.parse(JSON.stringify(cert));
  tamperedCmds.commands[0][0].type = 'product'; // rewrite history
  assert.equal(verifyCertificate(tamperedCmds).ok, false, 'command log tampering detected');
});

// ---------- CLI end-to-end: exit codes, stderr line numbers ----------
test('CLI: apply/query/verify exit codes and error reporting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  const state = join(dir, 'state.json');
  const dsl = join(dir, 'q.dsl');
  const cert = join(dir, 'cert.json');

  // child_process is blocked in some sandboxes, so drive the CLI in-process:
  // main() returns exactly the exit code bin/lineage.js exposes.
  const cli = (argv) => {
    const io = { out: [], err: [] };
    const code = main(argv, {
      out: (m) => io.out.push(m),
      err: (m) => io.err.push(m),
    });
    return { code, stdout: io.out.join('\n'), stderr: io.err.join('\n') };
  };

  writeFileSync(jsonl, [
    '{"op":"add","id":"LOT-2025-0001","type":"raw_material"}',
    '{"op":"add","id":"LOT-2025-0002","type":"intermediate"}',
    '{"op":"link","from":"LOT-2025-0001","to":"LOT-2025-0002"}',
    '',
  ].join('\n'));
  let r = cli(['apply', jsonl, '--state', state]);
  assert.equal(r.code, 0, r.stderr);

  writeFileSync(dsl, 'ancestors(LOT-2025-0002);\n');
  r = cli(['query', dsl, '--graph', state, '--cert', cert]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results[0].nodes, ['LOT-2025-0001']);

  r = cli(['verify', cert]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'OK');

  // tampered certificate -> exit 1
  const bad = JSON.parse(readFileSync(cert, 'utf8'));
  bad.results[0].nodes.push('LOT-2025-0009');
  writeFileSync(cert, JSON.stringify(bad));
  r = cli(['verify', cert]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /verification failed/);

  // malformed jsonl -> exit 2, line number on stderr, state untouched
  const stateBefore = readFileSync(state, 'utf8');
  writeFileSync(jsonl, [
    '{"op":"add","id":"LOT-2025-0003","type":"raw_material"}',
    '{"op":"link","from":"LOT-2025-0002","to":"LOT-2025-0001"}',
  ].join('\n'));
  r = cli(['apply', jsonl, '--state', state]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /graph\.jsonl:2: error:/);
  assert.equal(readFileSync(state, 'utf8'), stateBefore, 'failed apply leaves state file untouched');

  // DSL syntax error -> exit 2 with line number
  writeFileSync(dsl, 'let a = nodes();\nlet b = ;\n');
  r = cli(['query', dsl, '--graph', state]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /q\.dsl:2: error:/);

  // undo via CLI: link is retracted from persisted state
  const undoFile = join(dir, 'undo.jsonl');
  writeFileSync(undoFile, '{"op":"undo"}\n');
  r = cli(['apply', undoFile, '--state', state]);
  assert.equal(r.code, 0, r.stderr);
  writeFileSync(dsl, 'ancestors(LOT-2025-0002);\n');
  r = cli(['query', dsl, '--graph', state, '--cert', cert]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results[0].nodes, [], 'link undone via CLI');
});
