import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, emit } from '../test-support/helpers.js';
import { Store } from '../src/store.js';
import { makeEvent } from '../src/events.js';

function sync(a, b) {
  const r = runCli(['sync', '--a', a, '--b', b]);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

function createAndDistribute(a, b) {
  assert.equal(emit(a, 'site-a', 'u1', 'create', ['--wo', 'WO1']).status, 0);
  const r = sync(a, b);
  assert.equal(r.converged, true);
}

test('concurrent assigns by same actor to different teams resolve deterministically', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  createAndDistribute(a, b);
  // Same actor, offline on both sites, different teams.
  assert.equal(emit(a, 'site-a', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-x']).status, 0);
  assert.equal(emit(b, 'site-b', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-y']).status, 0);
  const r = sync(a, b);
  assert.equal(r.converged, true);
  const sa = Store.open(a).state;
  const sb = Store.open(b).state;
  // Deterministic rule: first in (site, seq) order wins -> site-a / team-x.
  assert.equal(sa.workorders.WO1.team, 'team-x');
  assert.equal(sb.workorders.WO1.team, 'team-x');
  assert.deepEqual(sa, sb);
  // The conflict is auditable on both sites.
  assert.equal(sa.conflicts.length, 1);
  assert.equal(sa.conflicts[0].resolution, 'first-wins');
  assert.deepEqual(sa.conflicts[0].teams, ['team-x', 'team-y']);
  const audit = runCli(['audit', '--dir', b]).json;
  assert.ok(audit.audit.some((e) => e.decision === 'rejected' && e.reason === 'conflict-loser'));
});

test('safety-interlock conflict goes to pending instead of auto-resolution', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  createAndDistribute(a, b);
  assert.equal(emit(a, 'site-a', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-x']).status, 0);
  assert.equal(
    emit(b, 'site-b', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-y', '--interlock']).status,
    0,
  );
  const r = sync(a, b);
  assert.equal(r.converged, true);
  const sa = Store.open(a).state;
  const sb = Store.open(b).state;
  assert.deepEqual(sa, sb);
  // The interlock assign is held pending on both sites; team unchanged.
  assert.equal(sa.workorders.WO1.team, 'team-x');
  assert.equal(sa.pending.length, 1);
  assert.equal(sa.pending[0].op, 'assign');
  assert.equal(sa.pending[0].interlock, true);
  assert.equal(sa.conflicts[0].resolution, 'pending');
  assert.equal(sa.conflicts[0].reason, 'safety-interlock');
});

test('alarm clear is valid only when causally after raise', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  // raise on A, sync, clear on B (B has seen the raise -> causally later).
  assert.equal(emit(a, 'site-a', 'u1', 'raise', ['--wo', 'WO1', '--alarm', 'AL1']).status, 0);
  sync(a, b);
  assert.equal(emit(b, 'site-b', 'u2', 'clear', ['--wo', 'WO1', '--alarm', 'AL1']).status, 0);
  const r = sync(a, b);
  assert.equal(r.converged, true);
  assert.equal(Store.open(a).state.alarms.AL1.status, 'cleared');
  assert.equal(Store.open(b).state.alarms.AL1.status, 'cleared');
});

test('concurrent clear (never saw the raise) is rejected, not applied', () => {
  const a = path.join(tmpdir(), 'a');
  assert.equal(emit(a, 'site-a', 'u1', 'raise', ['--wo', 'WO1', '--alarm', 'AL1']).status, 0);
  // Craft a clear from site-b that is concurrent with the raise.
  const clear = makeEvent({
    site: 'site-b', seq: 1, vc: { 'site-b': 1 }, kind: 'alarm', op: 'clear',
    wo: 'WO1', alarm: 'AL1', actor: 'u2', team: null, interlock: false, ts: 't',
  });
  const f = path.join(tmpdir(), 'ev.jsonl');
  fs.writeFileSync(f, JSON.stringify(clear) + '\n');
  const r = runCli(['apply', '--dir', a, '--file', f]);
  assert.equal(r.status, 0);
  const d = r.json.decisions.find((x) => x.event === clear.id);
  assert.equal(d.decision, 'rejected');
  assert.equal(d.reason, 'clear-not-after-raise');
  assert.equal(Store.open(a).state.alarms.AL1.status, 'raised');
});

test('clear with unknown raise goes to pending, resolves once raise arrives', () => {
  const c = path.join(tmpdir(), 'c');
  const clear = makeEvent({
    site: 'site-b', seq: 1, vc: { 'site-b': 1 }, kind: 'alarm', op: 'clear',
    wo: 'WO1', alarm: 'AL1', actor: 'u2', team: null, interlock: false, ts: 't',
  });
  const f = path.join(tmpdir(), 'ev.jsonl');
  fs.writeFileSync(f, JSON.stringify(clear) + '\n');
  const r1 = runCli(['apply', '--dir', c, '--file', f]);
  assert.equal(r1.status, 0);
  assert.equal(r1.json.pending, 1);
  assert.equal(Store.open(c).state.alarms.AL1, undefined);
  // A causally-later clear (vc includes the raise) becomes valid once the
  // raise shows up; the concurrent one stays rejected.
  const raise = makeEvent({
    site: 'site-a', seq: 1, vc: { 'site-a': 1 }, kind: 'alarm', op: 'raise',
    wo: 'WO1', alarm: 'AL1', actor: 'u1', team: null, interlock: false, ts: 't',
  });
  const clear2 = makeEvent({
    site: 'site-b', seq: 2, vc: { 'site-a': 1, 'site-b': 2 }, kind: 'alarm', op: 'clear',
    wo: 'WO1', alarm: 'AL1', actor: 'u2', team: null, interlock: false, ts: 't2',
  });
  fs.writeFileSync(f, JSON.stringify(raise) + '\n' + JSON.stringify(clear2) + '\n');
  const r2 = runCli(['apply', '--dir', c, '--file', f]);
  assert.equal(r2.status, 0);
  const st = Store.open(c).state;
  assert.equal(st.alarms.AL1.status, 'cleared');
  assert.equal(st.pending.length, 0);
});

test('event with missing causal predecessor stays pending until it arrives', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  createAndDistribute(a, b);
  // site-a emits assign + start; only start is shipped to b (gap in causal chain).
  assert.equal(emit(a, 'site-a', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-x']).status, 0);
  assert.equal(emit(a, 'site-a', 'u1', 'start', ['--wo', 'WO1']).status, 0);
  const lines = fs.readFileSync(path.join(a, 'events.jsonl'), 'utf8').trim().split('\n');
  const startOnly = lines[3]; // create, assign, start -> index 3? create=1? see below
  const f = path.join(tmpdir(), 'gap.jsonl');
  fs.writeFileSync(f, lines[2] + '\n'); // the start event only
  const r = runCli(['apply', '--dir', b, '--file', f]);
  assert.equal(r.status, 0);
  assert.equal(r.json.pending, 1);
  assert.equal(Store.open(b).state.workorders.WO1.status, 'new');
  // Now sync fully: the gap closes and the pending start applies.
  const s = sync(a, b);
  assert.equal(s.converged, true);
  assert.equal(Store.open(b).state.workorders.WO1.status, 'in_progress');
  assert.equal(Store.open(b).state.pending.length, 0);
});
