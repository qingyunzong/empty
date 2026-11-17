import assert from 'node:assert/strict';
import test from 'node:test';
import { QuicRecovery } from '../build/src/index.js';
import { runTrace } from './helpers.mjs';

function frame(id, size) {
  return { id, size };
}

function ackOnly(id) {
  return {
    id,
    size: 0,
    ackEliciting: false,
    retransmittable: false,
  };
}

test('trace: reordered ACK ranges, losses, and coalesced retransmission', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    packetThreshold: 3,
    handshakeConfirmed: true,
  });

  const events = runTrace(recovery, [
    ...[0, 1, 2, 3, 4, 5].map((index) => ({
      op: 'send',
      at: index * 10,
      space: 'application',
      frames: [frame(`f${index}`, 100)],
      overheadBytes: 10,
    })),
    {
      op: 'ack',
      at: 80,
      space: 'application',
      ranges: [{ smallest: 2, largest: 2 }],
      timer: {
        kind: 'pto',
        at: 255,
        space: 'application',
        ptoCount: 0,
        probeCount: 2,
      },
    },
    {
      op: 'send',
      at: 85,
      space: 'application',
      frames: [frame('f0', 100), frame('f1', 100)],
      overheadBytes: 10,
    },
    {
      op: 'ack',
      at: 130,
      space: 'application',
      ranges: [{ smallest: 3, largest: 6 }],
      timer: null,
    },
  ]);

  const firstAck = events[6].result;
  assert.equal(firstAck.rttSample, 60);
  assert.deepEqual(
    firstAck.lost.map((packet) => [packet.packetNumber, packet.lostBy]),
    [
      [0, 'time-threshold'],
      [1, 'time-threshold'],
    ],
  );
  assert.deepEqual(
    firstAck.lost.flatMap((packet) => packet.frames.map((item) => item.id)),
    ['f0', 'f1'],
  );
  assert.equal(firstAck.bytesInFlight, 330);

  assert.equal(events[7].bytesInFlight, 540);
  assert.deepEqual(
    events[7].frames.application
      .map((item) => item.id)
      .sort(),
    ['f0', 'f1', 'f3', 'f4', 'f5'],
  );

  const finalAck = events[8].result;
  assert.equal(finalAck.rttSample, 45);
  assert.deepEqual(
    finalAck.newlyAcked.map((packet) => packet.packetNumber),
    [3, 4, 5, 6],
  );
  assert.equal(recovery.bytesInFlight, 0);
  assert.equal(recovery.getTimer(), null);
});

test('trace: PTO backoff, probe reuse, and duplicate ACK delivery', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    handshakeConfirmed: true,
  });

  const events = runTrace(recovery, [
    {
      op: 'send',
      at: 0,
      space: 'application',
      frames: [frame('stream', 300)],
      overheadBytes: 20,
      timer: {
        kind: 'pto',
        at: 325,
        space: 'application',
        ptoCount: 0,
        probeCount: 2,
      },
    },
    { op: 'timer', at: 325 },
    {
      op: 'send',
      at: 325,
      space: 'application',
      frames: [frame('stream', 300)],
      overheadBytes: 20,
    },
    { op: 'timer', at: 975 },
    {
      op: 'send',
      at: 975,
      space: 'application',
      frames: [frame('stream', 300)],
      overheadBytes: 20,
    },
    {
      op: 'ack',
      at: 1000,
      space: 'application',
      ranges: [{ smallest: 0, largest: 0 }],
      timer: {
        kind: 'pto',
        at: 4000,
        space: 'application',
        ptoCount: 0,
        probeCount: 2,
      },
    },
    { op: 'timer', at: 4000 },
    {
      op: 'ack',
      at: 4100,
      space: 'application',
      ranges: [{ smallest: 1, largest: 2 }],
      timer: null,
    },
  ]);

  const firstPto = events[1].result;
  assert.equal(firstPto.kind, 'pto');
  assert.equal(firstPto.ptoCount, 1);
  assert.deepEqual(firstPto.timer, {
    kind: 'pto',
    at: 650,
    space: 'application',
    ptoCount: 1,
    probeCount: 2,
  });

  const secondPto = events[3].result;
  assert.equal(secondPto.kind, 'pto');
  assert.equal(secondPto.ptoCount, 2);
  assert.deepEqual(secondPto.timer, {
    kind: 'pto',
    at: 1625,
    space: 'application',
    ptoCount: 2,
    probeCount: 2,
  });

  assert.deepEqual(
    events[5].frames.application
      .map((item) => ({ id: item.id, copies: item.copies })),
    [],
  );

  const ackedFirst = events[5].result;
  assert.equal(ackedFirst.rttSample, 1000);
  assert.equal(events[5].bytesInFlight, 40);

  const thirdPto = events[6].result;
  assert.equal(thirdPto.kind, 'pto');
  assert.equal(thirdPto.ptoCount, 1);
  assert.deepEqual(thirdPto.timer, {
    kind: 'pto',
    at: 7025,
    space: 'application',
    ptoCount: 1,
    probeCount: 2,
  });

  const finalAck = events[7].result;
  assert.equal(finalAck.rttSample, 3125);
  assert.equal(recovery.bytesInFlight, 0);
});

test('trace: loss timer suppresses an earlier due PTO in another space', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: false,
  });

  const events = runTrace(recovery, [
    {
      op: 'send',
      at: 0,
      space: 'handshake',
      frames: [frame('handshake', 80)],
    },
    {
      op: 'send',
      at: 200,
      space: 'application',
      frames: [frame('stream', 100)],
    },
    {
      op: 'send',
      at: 200,
      space: 'application',
      frames: [ackOnly('ack')],
    },
    {
      op: 'ack',
      at: 210,
      space: 'application',
      ranges: [{ smallest: 1, largest: 1 }],
      timer: {
        kind: 'loss',
        at: 312.5,
        space: 'application',
      },
    },
    {
      op: 'timer',
      at: 301,
      timer: {
        kind: 'loss',
        at: 312.5,
        space: 'application',
      },
    },
    {
      op: 'timer',
      at: 312.5,
      timer: {
        kind: 'pto',
        at: 300,
        space: 'handshake',
        ptoCount: 0,
        probeCount: 2,
      },
    },
    { op: 'timer', at: 312.5 },
  ]);

  const ack = events[3].result;
  assert.equal(ack.rttSample, null);
  assert.equal(events[3].bytesInFlight, 180);

  const suppressed = events[4].result;
  assert.equal(suppressed.kind, 'none');
  assert.equal(events[4].bytesInFlight, 180);

  const loss = events[5].result;
  assert.equal(loss.kind, 'loss');
  assert.deepEqual(
    loss.lost.map((packet) => [packet.packetNumber, packet.lostBy]),
    [[0, 'time-threshold']],
  );
  assert.equal(events[5].bytesInFlight, 80);

  const pto = events[6].result;
  assert.equal(pto.kind, 'pto');
  assert.equal(pto.space, 'handshake');
  assert.equal(pto.ptoCount, 1);
});
