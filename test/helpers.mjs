import assert from 'node:assert/strict';
import {
  PACKET_NUMBER_SPACES,
} from '../build/src/index.js';

export function assertClose(actual, expected, epsilon = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, got ${actual}`,
  );
}

/**
 * Recomputes bytes_in_flight from the public per-frame view:
 *
 *   sum(unique undelivered frame bytes) + sum(packet overhead)
 *
 * Every deterministic trace step calls this, so a bookkeeping regression
 * fails at the event that introduced it.
 */
export function assertConservation(recovery) {
  assert.deepEqual(recovery.checkInvariants(), []);

  let total = 0;
  for (const space of PACKET_NUMBER_SPACES) {
    const frameIds = new Set();
    let frameBytes = 0;
    for (const frame of recovery.getInFlightFrames(space)) {
      assert.ok(
        !frameIds.has(String(frame.id)),
        `${space}: duplicate in-flight frame ${frame.id}`,
      );
      frameIds.add(String(frame.id));
      frameBytes += frame.size;
    }

    const overheadBytes = recovery
      .getSentPackets(space)
      .reduce((sum, packet) => sum + packet.overheadBytes, 0);

    const expected = frameBytes + overheadBytes;
    assert.equal(
      recovery.getBytesInFlight(space),
      expected,
      `${space}: bytes_in_flight conservation`,
    );
    total += expected;
  }

  assert.equal(recovery.bytesInFlight, total, 'global bytes_in_flight');
}

export function assertTimer(recovery, expected) {
  assert.deepEqual(recovery.getTimer(), expected);
}

/**
 * Execute a deterministic network trace.  Time must not move backwards and
 * the frame-level conservation identity is checked after every event.
 */
export function runTrace(recovery, steps) {
  const events = [];
  let previousTime = -Infinity;

  for (const [index, step] of steps.entries()) {
    assert.ok(
      step.at >= previousTime,
      `trace step ${index} moved time backwards`,
    );
    previousTime = step.at;

    let result;
    if (step.op === 'send') {
      result = recovery.sendPacket({
        space: step.space,
        now: step.at,
        frames: step.frames,
        ...(step.overheadBytes === undefined
          ? {}
          : { overheadBytes: step.overheadBytes }),
      });
    } else if (step.op === 'ack') {
      result = recovery.onAckReceived({
        space: step.space,
        now: step.at,
        ranges: step.ranges,
        ...(step.ackDelay === undefined ? {} : { ackDelay: step.ackDelay }),
      });
    } else if (step.op === 'timer') {
      result = recovery.onTimer(step.at);
    } else {
      throw new Error(`unknown trace op: ${step.op}`);
    }

    assertConservation(recovery);
    if (step.timer !== undefined) {
      assert.deepEqual(recovery.getTimer(), step.timer);
    }

    const frames = {};
    for (const space of PACKET_NUMBER_SPACES) {
      frames[space] = recovery.getInFlightFrames(space);
    }
    events.push({
      step,
      result,
      bytesInFlight: recovery.bytesInFlight,
      timer: recovery.getTimer(),
      frames,
    });
  }

  return events;
}
