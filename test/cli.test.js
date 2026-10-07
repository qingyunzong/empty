'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cli-'));

const write = (dir, name, lines) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

// Note: this sandbox drops pipe-captured stdout of spawned children, so the
// child's stdout is redirected to a file and read back.
const run = (cmdFile, stateDir) => {
  const outFile = path.join(path.dirname(cmdFile), `out-${process.hrtime.bigint()}.log`);
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI, cmdFile, '--state', stateDir], {
    stdio: ['ignore', fd, 'inherit'],
  });
  fs.closeSync(fd);
  res.stdout = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  return res;
};

const parseLines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const BASE = [
  { batch: 'harvest', defects: ['d0'] },
  { batch: 'wash', op: 'split', parents: ['harvest'], defects: ['d1'] },
  { batch: 'peel', op: 'split', parents: ['harvest'] },
  { batch: 'mix', op: 'merge', parents: ['wash', 'peel'] },
  { batch: 'qc', op: 'test', parents: ['mix'], status: 'pending' },
  { batch: 'out', op: 'ship', parents: ['qc'] },
];
const EXT = [
  { batch: 'rework', op: 'test', parents: ['qc'], defects: ['d2'] },
  { batch: 'recheck', op: 'ship', parents: ['rework'] },
];

test('end-to-end: import, equiv, rollback', () => {
  const dir = tmpdir();
  write(dir, 'base.jsonl', BASE);
  write(dir, 'ext.jsonl', EXT);
  write(dir, 'v2.jsonl', [
    { batch: 'src', defects: ['d0'] },
    { batch: 'cut-a', op: 'split', parents: ['src'], defects: ['d1'] },
    { batch: 'cut-b', op: 'split', parents: ['src'] },
    { batch: 'bundle', op: 'merge', parents: ['cut-a', 'cut-b'] },
    { batch: 'inspect', op: 'test', parents: ['bundle'], status: 'pending' },
    { batch: 'dispatch', op: 'ship', parents: ['inspect'] },
  ]);
  write(dir, 'v3.jsonl', BASE.map((r) => (r.batch === 'peel' ? { ...r, defects: ['d9'] } : r)));
  const cmd = write(dir, 'cmd.jsonl', [
    { cmd: 'import', file: 'base.jsonl' },
    { cmd: 'import', file: 'ext.jsonl' },
    { cmd: 'equiv', a: 'base.jsonl', b: 'v2.jsonl' },
    { cmd: 'equiv', a: 'base.jsonl', b: 'v3.jsonl' },
    { cmd: 'rollback', layer: 1 },
  ]);
  const state = path.join(dir, 'state');
  const res = run(cmd, state);
  assert.equal(res.status, 0, res.stderr);
  const out = parseLines(res.stdout);
  assert.deepEqual(out[0], { cmd: 'recover', recoveredTo: 0 });
  assert.equal(out[1].cmd, 'import');
  assert.equal(out[1].layer, 1);
  assert.equal(out[1].minStates, 3);
  assert.equal(out[1].recoveredTo, 1);
  assert.equal(out[2].layer, 2);
  assert.equal(out[2].minStates, 6);
  // isomorphic but renamed rules: equal, with a certificate
  assert.equal(out[3].equal, true);
  assert.match(out[3].certificate, /^[0-9a-f]{64}$/);
  assert.equal(out[3].witness, null);
  // differing rules: shortest witness
  assert.equal(out[4].equal, false);
  assert.deepEqual(out[4].witness, ['split']);
  // rollback to layer 1
  assert.deepEqual(out[5], { cmd: 'rollback', recoveredTo: 1, minStates: 3 });
  // a fresh run against the same state recovers to layer 1
  const res2 = run(cmd.replace('cmd.jsonl', 'noop.jsonl') && write(dir, 'noop.jsonl', []), state);
  assert.deepEqual(parseLines(res2.stdout)[0], { cmd: 'recover', recoveredTo: 1 });
});

test('acceptance 3: kill mid-layer, restart recovers to last complete layer', () => {
  const dir = tmpdir();
  write(dir, 'base.jsonl', BASE);
  write(dir, 'ext.jsonl', EXT);
  const state = path.join(dir, 'state');
  const cmd1 = write(dir, 'cmd1.jsonl', [{ cmd: 'import', file: 'base.jsonl' }]);
  assert.equal(run(cmd1, state).status, 0);
  // Simulate a kill in the middle of layer 2: begin + one record, no commit.
  const jf = path.join(state, 'journal.jsonl');
  fs.appendFileSync(jf, JSON.stringify({ type: 'begin', layer: 2, count: 2 }) + '\n');
  fs.appendFileSync(jf, JSON.stringify({ type: 'record', layer: 2, data: EXT[0] }) + '\n');
  // Restart with an empty command file: recovery must report layer 1 and the
  // rebuilt state must equal the state right after layer 1.
  const cmd2 = write(dir, 'cmd2.jsonl', []);
  const res = run(cmd2, state);
  assert.equal(res.status, 0);
  assert.deepEqual(parseLines(res.stdout)[0], { cmd: 'recover', recoveredTo: 1 });
  // And the torn layer can be re-imported cleanly as the new layer 2.
  const cmd3 = write(dir, 'cmd3.jsonl', [{ cmd: 'import', file: 'ext.jsonl' }]);
  const res3 = run(cmd3, state);
  const out3 = parseLines(res3.stdout);
  assert.equal(out3[0].recoveredTo, 1);
  assert.equal(out3[1].layer, 2);
  assert.equal(out3[1].minStates, 6);
});

test('exit code 4: cyclic genealogy', () => {
  const dir = tmpdir();
  write(dir, 'bad.jsonl', [
    { batch: 'a', op: 'test', parents: ['b'] },
    { batch: 'b', op: 'test', parents: ['a'] },
  ]);
  const cmd = write(dir, 'cmd.jsonl', [{ cmd: 'import', file: 'bad.jsonl' }]);
  const res = run(cmd, path.join(dir, 'state'));
  assert.equal(res.status, 4);
  const err = parseLines(res.stdout).at(-1);
  assert.equal(err.kind, 'CYCLIC_GENEALOGY');
});

test('exit code 4: unknown parent batch', () => {
  const dir = tmpdir();
  write(dir, 'bad.jsonl', [{ batch: 'a', op: 'merge', parents: ['ghost'] }]);
  const cmd = write(dir, 'cmd.jsonl', [{ cmd: 'import', file: 'bad.jsonl' }]);
  const res = run(cmd, path.join(dir, 'state'));
  assert.equal(res.status, 4);
  assert.equal(parseLines(res.stdout).at(-1).kind, 'UNKNOWN_PARENT');
});

test('exit code 4: layer number hole', () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const jf = path.join(state, 'journal.jsonl');
  const layer = (n, rec) =>
    [
      { type: 'begin', layer: n, count: 1 },
      { type: 'record', layer: n, data: rec },
      { type: 'commit', layer: n },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n';
  fs.writeFileSync(jf, layer(1, { batch: 'a' }) + layer(3, { batch: 'b', op: 'split', parents: ['a'] }));
  const cmd = write(dir, 'cmd.jsonl', []);
  const res = run(cmd, state);
  assert.equal(res.status, 4);
  assert.equal(parseLines(res.stdout).at(-1).kind, 'LAYER_HOLE');
});

test('rejected import leaves no trace in the journal', () => {
  const dir = tmpdir();
  write(dir, 'ok.jsonl', [{ batch: 'a' }]);
  write(dir, 'bad.jsonl', [{ batch: 'b', op: 'split', parents: ['nope'] }]);
  const state = path.join(dir, 'state');
  assert.equal(run(write(dir, 'c1.jsonl', [{ cmd: 'import', file: 'ok.jsonl' }]), state).status, 0);
  assert.equal(run(write(dir, 'c2.jsonl', [{ cmd: 'import', file: 'bad.jsonl' }]), state).status, 4);
  const res = run(write(dir, 'c3.jsonl', []), state);
  assert.deepEqual(parseLines(res.stdout)[0], { cmd: 'recover', recoveredTo: 1 });
});
