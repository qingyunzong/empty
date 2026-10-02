// 验收1: 随机历史(<=9 步)对照独立参考自动机。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, minimalViolation, COMMANDS, SENSORS, SENSOR_VALUES } from '../src/machine.js';
import { mulberry32, pick, randInt } from '../src/rng.js';

// 参考自动机: 独立实现同一规约, 用于差分对照。
function reference(history) {
  let phase = 'IDLE';
  const sensors = { DOOR: 'UNKNOWN', PRESSURE: 'UNKNOWN', TEMP: 'UNKNOWN' };
  const issued = new Set();
  let unknown = false;
  let violationIndex = -1;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    let status = 'OK';
    if (e.type === 'ack') {
      const cause = { DOOR: 'LOCK_DOOR', PRESSURE: 'START_HEAT', TEMP: 'START_HEAT' }[e.sensor];
      if (!cause || !issued.has(cause)) status = 'VIOLATION';
      else sensors[e.sensor] = e.value;
    } else if (e.type === 'cmd') {
      issued.add(e.name);
      switch (e.name) {
        case 'LOCK_DOOR':
          if (phase !== 'IDLE') status = 'VIOLATION'; else phase = 'READY';
          break;
        case 'START_HEAT':
          if (phase !== 'READY') status = 'VIOLATION'; else phase = 'HEATING';
          break;
        case 'STOP_HEAT':
          if (phase !== 'HEATING') status = 'VIOLATION'; else phase = 'COOLING';
          break;
        case 'OPEN_EXHAUST':
          if (phase === 'HEATING') {
            if (sensors.PRESSURE === 'UNKNOWN') status = 'UNKNOWN';
            else if (sensors.PRESSURE !== 'OK') status = 'VIOLATION';
            else phase = 'VENTING';
          } else if (phase === 'COOLING' || phase === 'VENTING') {
            phase = 'VENTING';
          } else status = 'VIOLATION';
          break;
        case 'OPEN_DOOR':
          if (sensors.PRESSURE === 'UNKNOWN') status = 'UNKNOWN';
          else if (sensors.PRESSURE !== 'ZERO') status = 'VIOLATION';
          else phase = 'IDLE';
          break;
        default:
          status = 'VIOLATION';
      }
    } else status = 'VIOLATION';

    if (status === 'VIOLATION') {
      if (violationIndex < 0) violationIndex = i;
    } else if (status === 'UNKNOWN') {
      unknown = true;
    }
  }
  const verdict = violationIndex >= 0 ? 'VIOLATION' : unknown ? 'UNKNOWN' : 'SAFE';
  return { verdict, violationIndex, phase, sensors };
}

function randomHistory(rng) {
  const n = randInt(rng, 1, 9);
  const h = [];
  for (let i = 0; i < n; i++) {
    if (rng() < 0.55) {
      h.push({ type: 'cmd', name: pick(rng, COMMANDS) });
    } else {
      const sensor = pick(rng, SENSORS);
      h.push({ type: 'ack', sensor, value: pick(rng, SENSOR_VALUES[sensor]) });
    }
  }
  return h;
}

test('随机历史 <=9 步: 判定/违例位置/终态与参考自动机一致', () => {
  const tallies = { SAFE: 0, UNKNOWN: 0, VIOLATION: 0 };
  for (let seed = 1; seed <= 2000; seed++) {
    const rng = mulberry32(seed);
    const h = randomHistory(rng);
    const got = evaluate(h);
    const want = reference(h);
    tallies[got.verdict]++;
    assert.equal(got.verdict, want.verdict, `seed=${seed} history=${JSON.stringify(h)}`);
    assert.equal(got.violationIndex, want.violationIndex, `seed=${seed}`);
    assert.equal(got.safeState.phase, want.phase, `seed=${seed}`);
    assert.deepEqual(got.safeState.sensors, want.sensors, `seed=${seed}`);
    const mv = minimalViolation(h);
    if (want.violationIndex >= 0) {
      assert.equal(mv.length, want.violationIndex + 1, `seed=${seed}: minimal prefix`);
    } else {
      assert.equal(mv, null, `seed=${seed}`);
    }
  }
  // 三类判定均被覆盖, 说明生成器有区分度
  assert.ok(tallies.SAFE > 0 && tallies.UNKNOWN > 0 && tallies.VIOLATION > 0, JSON.stringify(tallies));
});
