import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../bin/cli.js';

test('CLI: commit/branch/merge/undo/query end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maint-'));
  const store = join(dir, 'store.json');
  const run = (...args) => runCli(['--store', store, ...args]);

  let r = run('branch', 'main');
  assert.equal(r.code, 0);
  assert.match(r.out, /branch main/);

  r = run('commit', '--branch', 'main', '--set', 'w1.note=更换轴承', '--message', 'c1');
  assert.match(r.out, /^v1 lamport=1/);

  run('branch', 'feat', '--from', 'v1');
  run('commit', '--branch', 'feat', '--set', 'w1.note=更换皮带');
  run('commit', '--branch', 'main', '--set', 'w1.note=复检轴承', '--set', 'w2.note=紧固螺栓');

  // concurrent same-field edit -> E_CONFLICT, exit 1, conflict fields listed
  r = run('merge', '--branch', 'main', '--from', 'feat');
  assert.equal(r.code, 1);
  assert.match(r.err, /E_CONFLICT/);
  assert.match(r.err, /w1\.note/);
  assert.match(r.err, /ours="复检轴承" theirs="更换皮带"/);

  // resolve and merge
  r = run('merge', '--branch', 'main', '--from', 'feat', '--resolve', 'w1.note=更换轴承');
  assert.equal(r.code, 0);
  assert.match(r.out, /merge parents=\[v3,v2\]/);

  // query sees merged state at head
  r = run('query', '--phrase', '更换轴承');
  assert.match(r.out, /^w1\t/m);

  // undo a normal commit; old version stays readable via --as-of
  r = run('commit', '--branch', 'main', '--set', 'w1.note=临时结论');
  const vid = r.out.match(/^(v\d+)/)[1];
  r = run('undo', '--branch', 'main', '--version', vid);
  assert.match(r.out, new RegExp(`undo of ${vid}`));
  r = run('query', '--phrase', '临时结论', '--as-of', vid);
  assert.match(r.out, /^w1\t/m);
  r = run('query', '--phrase', '临时结论');
  assert.equal(r.out.trim(), '');

  // compaction keeps as_of results stable
  const beforeQ = run('query', '--phrase', '更换轴承', '--as-of', 'v4').out;
  run('compact');
  const afterQ = run('query', '--phrase', '更换轴承', '--as-of', 'v4').out;
  assert.equal(beforeQ, afterQ);

  // error codes
  assert.match(run('commit', '--branch', 'main', '--lamport', '1').err, /E_CLOCK/);
  assert.match(run('query', '--phrase', 'x', '--as-of', 'v999').err, /E_VERSION/);
  assert.match(run('commit', '--branch', 'ghost').err, /E_VERSION/);
});
