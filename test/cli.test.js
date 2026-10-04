import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ev, branch } from './helpers.js';
import { MergeSession } from '../src/session.js';
import { Store } from '../src/store.js';

// The CLI is deterministic and snapshots are content-addressed, so the whole
// script (including versions and conflict ids) is computed up front, then
// replayed through the real CLI process.
test('JSONL CLI end-to-end: load, merge, resolve, commit, check, diff, inverse', () => {
  const baseEvents = [ev('A', 1, { note: 'x' }), ev('D', 2), ev('F', 3, { dependsOn: ['D'] })];
  const localEvents = [ev('A', 1, { note: 'a' }), ev('D', 2, { deleted: true }), ev('F', 3, { dependsOn: ['D'] })];
  const remoteEvents = [ev('A', 1, { note: 'b' }), ev('D', 2, { note: 'edited' }), ev('F', 3, { dependsOn: ['D'] })];

  // Replicate exactly what the CLI will do, to precompute versions/ids.
  const ref = new Store(mkdtempSync(join(tmpdir(), 'emref-')));
  const baseV = ref.putSnapshot({ events: branch(baseEvents), parents: [], meta: { kind: 'branch', name: 'base' } });
  const localV = ref.putSnapshot({ events: branch(localEvents), parents: [], meta: { kind: 'branch', name: 'local' } });
  const remoteV = ref.putSnapshot({ events: branch(remoteEvents), parents: [], meta: { kind: 'branch', name: 'remote' } });
  const s = new MergeSession({
    base: branch(baseEvents),
    local: branch(localEvents),
    remote: branch(remoteEvents),
    versions: { base: baseV, local: localV, remote: remoteV },
  });
  const fieldC = s.result.conflicts.find((c) => c.type === 'FIELD');
  const duC = s.result.conflicts.find((c) => c.type === 'DELETE_UPDATE');
  s.resolve({ conflictId: fieldC.conflictId, expectLocal: 'a', expectRemote: 'b', pick: 'remote' });
  s.resolve({ conflictId: duC.conflictId, expectLocal: duC.local, expectRemote: duC.remote, pick: 'remote' });
  const mergeV = s.commit(ref);
  const inverse = ref.invert(ref.diff(baseV, mergeV));

  const script = [
    { cmd: 'load', name: 'base', events: baseEvents },
    { cmd: 'load', name: 'local', events: localEvents },
    { cmd: 'load', name: 'remote', events: remoteEvents },
    { cmd: 'merge', base: 'base', local: 'local', remote: 'remote' },
    { cmd: 'resolve', session: 's1', conflictId: fieldC.conflictId, expectLocal: 'a', expectRemote: 'b', pick: 'remote' },
    { cmd: 'resolve', session: 's1', conflictId: duC.conflictId, expectLocal: duC.local, expectRemote: duC.remote, pick: 'remote' },
    { cmd: 'commit', session: 's1' },
    { cmd: 'check', version: mergeV },
    { cmd: 'projection', version: mergeV },
    { cmd: 'diff', from: baseV, to: mergeV },
    { cmd: 'applyInverse', version: mergeV, diff: inverse },
    { cmd: 'applyInverse', version: mergeV, diff: { ...inverse, toEventsHash: '0'.repeat(64) } },
    { cmd: 'head' },
  ];

  const dir = mkdtempSync(join(tmpdir(), 'emcli-'));
  const scriptFile = join(dir, 'script.jsonl');
  const outFile = join(dir, 'out.jsonl');
  writeFileSync(scriptFile, script.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const run = spawnSync(
    'sh',
    ['-c', `node bin/cli.js --store ${join(dir, 'store')} --input ${scriptFile} > ${outFile}`],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const out = readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, script.length);

  assert.ok(out[0].ok && out[1].ok && out[2].ok);
  assert.equal(out[0].version, baseV);
  assert.equal(out[1].version, localV);
  assert.equal(out[2].version, remoteV);

  const merge = out[3];
  assert.ok(merge.ok);
  assert.equal(merge.session, 's1');
  assert.equal(merge.conflicts.length, 2);
  assert.deepEqual(merge.blocked, [{ id: 'F', blockedBy: ['D'] }]);

  assert.ok(out[4].ok);
  assert.equal(out[4].state.blocked.length, 1); // still blocked: D deleted
  assert.ok(out[5].ok);
  assert.equal(out[5].state.blocked.length, 0); // unblocked by pick=remote

  assert.ok(out[6].ok);
  assert.equal(out[6].version, mergeV);

  assert.ok(out[7].ok, JSON.stringify(out[7])); // independent checker

  assert.deepEqual(out[8].order, ['A', 'D', 'F']); // projection hides deleted, keeps causal order

  assert.ok(out[9].ok);
  assert.deepEqual(out[9].diff.ops.map((o) => `${o.op}:${o.id}`).sort(), ['set:A', 'set:D']);

  assert.ok(out[10].ok); // inverse applied, post-image hash verified
  assert.equal(out[11].ok, false);
  assert.equal(out[11].code, 'POSTIMAGE_HASH_MISMATCH');
  assert.equal(out[12].head, mergeV); // failed inverse left HEAD untouched
});

test('JSONL CLI rejects invalid branches', () => {
  const script = [
    { cmd: 'load', name: 'bad', events: [ev('A', 1, { dependsOn: ['NOPE'] })] },
    { cmd: 'validate', events: [ev('A', 1, { dependsOn: ['A'] })] },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'emcli-'));
  const scriptFile = join(dir, 'script.jsonl');
  const outFile = join(dir, 'out.jsonl');
  writeFileSync(scriptFile, script.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const run = spawnSync('sh', ['-c', `node bin/cli.js --store ${join(dir, 'store')} --input ${scriptFile} > ${outFile}`], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const out = readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out[0].ok, false);
  assert.equal(out[0].code, 'INVALID_BRANCH');
  assert.equal(out[0].errors[0].type, 'MISSING_REF');
  assert.equal(out[1].ok, true);
  assert.equal(out[1].valid, false);
  assert.equal(out[1].errors[0].type, 'CYCLE');
});
