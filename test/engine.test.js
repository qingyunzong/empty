import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, certifyEvents, DEFAULTS } from '../index.js';

const calib = (id, ts, tool, extra = {}) => ({
  id,
  type: 'calib',
  eventTs: ts,
  tool,
  ok: true,
  validFrom: 0,
  validTo: 5000,
  op: 'QA',
  ...extra,
});
const torque = (id, ts, bolt, tool, angle, extra = {}) => ({
  id,
  type: 'torque',
  eventTs: ts,
  bolt,
  tool,
  peak: 12.5,
  angle,
  op: 'OP1',
  ...extra,
});
const scan = (id, ts, bolt, lot) => ({ id, type: 'scan', eventTs: ts, bolt, lot, op: 'OP1' });
const retract = (ts, kind, id) => ({ type: 'retract', eventTs: ts, kind, id });

const versionsOf = (result, bolt) => result.certs.filter((c) => c.bolt === bolt);
const statusesOf = (result, bolt) => versionsOf(result, bolt).map((c) => c.status);

test('calib retraction cascades OK -> VOID and recovery keeps all versions', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 45),
    scan('s1', 1200, 'B1', 'L1'),
    retract(3000, 'calib', 'c1'),
    calib('c2', 4000, 'T1'),
  ]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD', 'OK', 'VOID', 'OK']);
  const versions = versionsOf(result, 'B1');
  assert.deepEqual(versions.map((c) => c.version), [1, 2, 3, 4]);
  assert.equal(versions[1].calibId, 'c1'); // old version retained, not deleted
  assert.equal(versions[2].reason, 'NO_CALIB');
  assert.equal(versions[3].calibId, 'c2');
  assert.equal(result.voids.length, 1);
  assert.equal(result.voids[0].bolt, 'B1');
  assert.equal(result.voids[0].voidedVersion, 2);
  assert.equal(result.voids[0].version, 3);
  assert.equal(result.errors.length, 0);
});

test('late scan (behind watermark) is logged and flips HOLD -> OK', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 45),
    torque('t2', 5000, 'B2', 'T1', 30), // advances watermark to 5000
    scan('s1', 1200, 'B1', 'L1'), // eventTs 1200 < watermark 5000 -> late
  ]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD', 'OK']);
  const hold = versionsOf(result, 'B1')[0];
  assert.equal(hold.reason, 'NO_LOT');
  assert.equal(result.late.length, 1);
  assert.equal(result.late[0].id, 's1');
  assert.equal(result.late[0].watermark, 5000);
  assert.equal(result.errors.length, 0);
});

test('missing lot yields HOLD without errors', () => {
  const result = certifyEvents([calib('c1', 100, 'T1'), torque('t1', 1000, 'B1', 'T1', 45)]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD']);
  assert.equal(result.errors.length, 0);
});

test('duplicate id with conflicting payload reports DUP_EVENT and keeps first', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 10),
    torque('t1', 1000, 'B1', 'T1', 20), // same id, different angle
  ]);
  assert.equal(result.errors.filter((e) => e.code === 'DUP_EVENT').length, 1);
  assert.equal(result.errors[0].id, 't1');
  const cert = versionsOf(result, 'B1')[0];
  assert.equal(cert.angle, 10); // first occurrence wins
});

test('identical duplicate id is an idempotent no-op', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 10),
    torque('t1', 1000, 'B1', 'T1', 10),
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.certs.length, 1);
});

test('illegal angle reports ANGLE_RANGE and is disqualified', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 50),
    torque('t2', 2000, 'B1', 'T1', 400), // out of [0, 360]
    scan('s1', 1050, 'B1', 'L1'),
  ]);
  const angleErrors = result.errors.filter((e) => e.code === 'ANGLE_RANGE');
  assert.equal(angleErrors.length, 1);
  assert.equal(angleErrors[0].id, 't2');
  // last *qualified* tightening wins: t1, not the newer illegal t2
  const certs = versionsOf(result, 'B1');
  const cert = certs[certs.length - 1];
  assert.equal(cert.status, 'OK');
  assert.equal(cert.torqueId, 't1');
});

test('multiple tightenings: last qualified event wins, ties by (eventTs, id)', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 10),
    torque('t2', 1000, 'B1', 'T1', 20), // same eventTs, larger id wins
    scan('s1', 1100, 'B1', 'L1'),
  ]);
  const certs = versionsOf(result, 'B1');
  const cert = certs[certs.length - 1];
  assert.equal(cert.torqueId, 't2');
  assert.equal(cert.angle, 20);
});

test('scan retraction voids the cert, a replacement scan recovers it', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 45),
    scan('s1', 1100, 'B1', 'L1'),
    retract(2000, 'scan', 's1'),
    scan('s2', 1200, 'B1', 'L2'),
  ]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD', 'OK', 'VOID', 'OK']);
  const versions = versionsOf(result, 'B1');
  assert.equal(versions[2].reason, 'NO_LOT');
  assert.equal(versions[3].lot, 'L2');
  assert.equal(result.voids.length, 1);
});

test('scan outside the +-500ms window does not certify', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 45),
    scan('s1', 1601, 'B1', 'L1'), // 601ms away > 500ms window
  ]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD']);
});

test('calib validity interval must cover the tightening eventTs', () => {
  const result = certifyEvents([
    calib('c1', 100, 'T1', { validFrom: 2000, validTo: 3000 }),
    torque('t1', 1000, 'B1', 'T1', 45),
    scan('s1', 1100, 'B1', 'L1'),
  ]);
  assert.deepEqual(statusesOf(result, 'B1'), ['HOLD', 'HOLD']);
  assert.ok(versionsOf(result, 'B1').every((c) => c.reason === 'NO_CALIB'));
});

// Acceptance 3: enumerate every subset of a small event set and compare the
// final certificate of each bolt against an independent oracle.
test('exhaustive subset enumeration matches oracle certificates', () => {
  const cfg = { ...DEFAULTS };
  const universe = [
    calib('c1', 100, 'T1'),
    torque('t1', 1000, 'B1', 'T1', 40),
    scan('s1', 1100, 'B1', 'L1'),
    torque('t2', 2000, 'B1', 'T1', 50),
    scan('s2', 2400, 'B1', 'L2'),
    { id: 'r1', type: 'retract', eventTs: 9000, kind: 'torque', id: 't2' },
  ];
  const canon = (a, b) =>
    a.eventTs - b.eventTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const lastOf = (list) =>
    list.reduce(
      (best, e) =>
        !best || e.eventTs > best.eventTs || (e.eventTs === best.eventTs && e.id > best.id)
          ? e
          : best,
      null,
    );
  const certEqual = (a, b) =>
    a &&
    b &&
    a.status === b.status &&
    a.reason === b.reason &&
    a.torqueId === b.torqueId &&
    a.calibId === b.calibId &&
    a.scanId === b.scanId &&
    a.lot === b.lot;

  // Independent oracle: set-based recompute after every event, in canonical order.
  function oracle(subset) {
    const events = [...subset].sort(canon);
    const retracted = new Set();
    const issued = new Map();
    const bolts = [...new Set(events.filter((e) => e.type === 'torque').map((e) => e.bolt))];
    const seen = [];
    const active = () => seen.filter((e) => e.type !== 'retract' && !retracted.has(e.id));
    const compute = (bolt, prev) => {
      const act = active();
      const qualified = act.filter(
        (e) =>
          e.type === 'torque' &&
          e.bolt === bolt &&
          e.angle >= cfg.angleMin &&
          e.angle <= cfg.angleMax,
      );
      if (!qualified.length) return null;
      const eff = lastOf(qualified);
      const cal = lastOf(
        act.filter(
          (e) =>
            e.type === 'calib' &&
            e.tool === eff.tool &&
            e.ok &&
            e.validFrom <= eff.eventTs &&
            eff.eventTs <= e.validTo,
        ),
      );
      const sc = lastOf(
        act.filter(
          (e) =>
            e.type === 'scan' && e.bolt === bolt && Math.abs(e.eventTs - eff.eventTs) <= cfg.windowMs,
        ),
      );
      let status = cal && sc ? 'OK' : 'HOLD';
      let reason = status === 'OK' ? null : !cal ? 'NO_CALIB' : 'NO_LOT';
      if (status !== 'OK' && prev && (prev.status === 'OK' || prev.status === 'VOID')) {
        status = 'VOID';
      }
      return {
        status,
        reason,
        torqueId: eff.id,
        calibId: cal ? cal.id : null,
        scanId: sc ? sc.id : null,
        lot: sc ? sc.lot : null,
      };
    };
    for (const e of events) {
      if (e.type === 'retract') retracted.add(e.id);
      else seen.push(e);
      for (const bolt of bolts) {
        const next = compute(bolt, issued.get(bolt));
        if (next && !certEqual(next, issued.get(bolt))) issued.set(bolt, next);
      }
    }
    return issued;
  }

  let checked = 0;
  for (let mask = 0; mask < 1 << universe.length; mask++) {
    const subset = universe.filter((_, i) => mask & (1 << i));
    const ordered = [...subset].sort(canon);
    const engine = new Engine(cfg);
    ordered.forEach((raw, i) => engine.apply(raw, { line: i + 1 }));
    const expected = oracle(subset);
    const actual = engine.finalCerts();
    assert.equal(
      actual.size,
      expected.size,
      `subset ${mask.toString(2)}: certified bolt set differs`,
    );
    for (const [bolt, want] of expected) {
      const got = actual.get(bolt);
      assert.ok(got, `subset ${mask.toString(2)}: missing cert for ${bolt}`);
      for (const key of ['status', 'reason', 'torqueId', 'calibId', 'scanId', 'lot']) {
        assert.equal(got[key], want[key], `subset ${mask.toString(2)}: ${bolt}.${key}`);
      }
    }
    // Invariants: versions strictly increase per bolt; voids only OK -> VOID.
    for (const versions of engine.certs.values()) {
      versions.forEach((v, i) => assert.equal(v.version, i + 1));
    }
    for (const v of engine.voids) assert.equal(v.version, v.voidedVersion + 1);
    checked++;
  }
  assert.equal(checked, 1 << universe.length);
});
