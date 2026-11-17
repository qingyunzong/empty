import assert from 'node:assert/strict';
import test from 'node:test';
import { QuicRecovery } from '../build/src/index.js';
import {
  assertClose,
  assertConservation,
} from './helpers.mjs';

function packetFrame(id, size = 100) {
  return { id, size };
}

test('ACK ranges drive packet-number and time-threshold loss detection', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    handshakeConfirmed: true,
  });

  for (let packetNumber = 0; packetNumber < 6; packetNumber += 1) {
    recovery.sendPacket({
      space: 'application',
      now: packetNumber * 10,
      frames: [packetFrame(`f${packetNumber}`)],
    });
  }
  assert.equal(recovery.bytesInFlight, 600);
  assertConservation(recovery);

  const ack = recovery.onAckReceived({
    space: 'application',
    now: 120,
    ranges: [
      { smallest: 3, largest: 3 },
      { smallest: 5, largest: 5 },
    ],
  });

  assert.equal(ack.rttSample, 70);
  assert.equal(ack.rtt.latestRtt, 70);
  assert.equal(ack.rtt.smoothedRtt, 70);
  assert.deepEqual(
    ack.newlyAcked.map((packet) => packet.packetNumber),
    [3, 5],
  );
  assert.deepEqual(
    ack.lost.map((packet) => [packet.packetNumber, packet.lostBy]),
    [
      [0, 'packet-threshold'],
      [1, 'packet-threshold'],
      [2, 'packet-threshold'],
      [4, 'time-threshold'],
    ],
  );
  assert.equal(ack.bytesInFlight, 0);
  assert.equal(ack.timer, null);
  assertConservation(recovery);
});

test('packet number spaces keep independent sent/acked state', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: false,
  });

  const initial = recovery.sendPacket({
    space: 'initial',
    now: 0,
    frames: [packetFrame('initial-crypto', 120)],
  });
  const handshake = recovery.sendPacket({
    space: 'handshake',
    now: 5,
    frames: [packetFrame('handshake-crypto', 80)],
  });
  const application = recovery.sendPacket({
    space: 'application',
    now: 10,
    frames: [packetFrame('stream', 60)],
  });

  assert.equal(initial.packetNumber, 0);
  assert.equal(handshake.packetNumber, 0);
  assert.equal(application.packetNumber, 0);
  assert.equal(recovery.getBytesInFlight('initial'), 120);
  assert.equal(recovery.getBytesInFlight('handshake'), 80);
  assert.equal(recovery.getBytesInFlight('application'), 60);
  assert.equal(recovery.bytesInFlight, 260);

  // Application PTO is suppressed before handshake confirmation.
  assert.deepEqual(recovery.getTimer(), {
    kind: 'pto',
    at: 300,
    space: 'initial',
    ptoCount: 0,
    probeCount: 2,
  });

  const appAck = recovery.onAckReceived({
    space: 'application',
    now: 100,
    ranges: [{ smallest: 0, largest: 0 }],
    ackDelay: 50,
  });
  assert.equal(appAck.rttSample, 90);
  assert.equal(recovery.getBytesInFlight('application'), 0);
  assert.equal(recovery.getBytesInFlight('initial'), 120);
  assert.equal(recovery.getBytesInFlight('handshake'), 80);

  const initialAck = recovery.onAckReceived({
    space: 'initial',
    now: 110,
    ranges: [{ smallest: 0, largest: 0 }],
  });
  assert.equal(initialAck.rttSample, 110);
  assert.equal(recovery.getBytesInFlight('initial'), 0);
  assert.equal(recovery.getBytesInFlight('handshake'), 80);

  recovery.onAckReceived({
    space: 'handshake',
    now: 120,
    ranges: [{ smallest: 0, largest: 0 }],
  });
  assert.equal(recovery.bytesInFlight, 0);
  assert.equal(recovery.getTimer(), null);

  assert.equal(
    recovery.getSpaceSnapshot('application').largestAcked,
    0,
  );
  assert.equal(recovery.getSpaceSnapshot('initial').largestAcked, 0);
  assert.equal(recovery.getSpaceSnapshot('handshake').largestAcked, 0);
  assertConservation(recovery);
});

test('RTT samples use the largest newly acknowledged ack-eliciting packet', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: true,
  });

  recovery.sendPacket({
    space: 'application',
    now: 0,
    frames: [packetFrame('older')],
  });
  recovery.sendPacket({
    space: 'application',
    now: 50,
    frames: [
      {
        id: 'ack-only',
        size: 0,
        ackEliciting: false,
        retransmittable: false,
      },
    ],
  });
  recovery.sendPacket({
    space: 'application',
    now: 80,
    frames: [packetFrame('largest-new')],
  });

  const first = recovery.onAckReceived({
    space: 'application',
    now: 150,
    ranges: [{ smallest: 0, largest: 2 }],
  });
  // Packet 1 is ACK-only and is not tracked as in flight.  Packet 2 is the
  // largest newly acknowledged ack-eliciting packet, so the sample is 70,
  // not 150 (packet 0) and not 100 (the ACK-only packet).
  assert.equal(first.rttSample, 70);
  assert.equal(first.rtt.latestRtt, 70);

  recovery.sendPacket({
    space: 'application',
    now: 200,
    frames: [packetFrame('next')],
  });
  const second = recovery.onAckReceived({
    space: 'application',
    now: 260,
    ranges: [{ smallest: 3, largest: 3 }],
  });
  assert.equal(second.rttSample, 60);

  const duplicateAck = recovery.onAckReceived({
    space: 'application',
    now: 300,
    ranges: [{ smallest: 0, largest: 3 }],
  });
  assert.equal(duplicateAck.rttSample, null);
  assert.equal(duplicateAck.rtt.latestRtt, 60);

  recovery.sendPacket({
    space: 'application',
    now: 310,
    frames: [
      {
        id: 'ack-only-2',
        size: 0,
        ackEliciting: false,
        retransmittable: false,
      },
    ],
  });
  const ackOnlyAck = recovery.onAckReceived({
    space: 'application',
    now: 320,
    ranges: [{ smallest: 4, largest: 4 }],
  });
  assert.equal(ackOnlyAck.rttSample, null);
  assert.equal(ackOnlyAck.rtt.latestRtt, 60);
  assertConservation(recovery);
});

test('ACK delay is applied only to confirmed application space', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    handshakeConfirmed: true,
  });

  recovery.sendPacket({
    space: 'application',
    now: 0,
    frames: [packetFrame('one')],
  });
  recovery.onAckReceived({
    space: 'application',
    now: 100,
    ranges: [{ smallest: 0, largest: 0 }],
    ackDelay: 50,
  });
  assert.equal(recovery.rtt.smoothedRtt, 100);

  recovery.sendPacket({
    space: 'application',
    now: 200,
    frames: [packetFrame('two')],
  });
  recovery.onAckReceived({
    space: 'application',
    now: 350,
    ranges: [{ smallest: 1, largest: 1 }],
    ackDelay: 80,
  });

  assertClose(recovery.rtt.smoothedRtt, 103.125);
  assertClose(recovery.rtt.rttvar, 43.75);
  assert.equal(recovery.rtt.minRtt, 100);
});

test('PTO backs off, probes reuse a frame, and ACK resets backoff', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    handshakeConfirmed: true,
  });

  recovery.sendPacket({
    space: 'application',
    now: 0,
    frames: [packetFrame('stream-1')],
    overheadBytes: 10,
  });
  assert.equal(recovery.bytesInFlight, 110);
  assert.deepEqual(recovery.getTimer(), {
    kind: 'pto',
    at: 325,
    space: 'application',
    ptoCount: 0,
    probeCount: 2,
  });

  const early = recovery.onTimer(324);
  assert.equal(early.kind, 'none');
  assert.deepEqual(early.timer, {
    kind: 'pto',
    at: 325,
    space: 'application',
    ptoCount: 0,
    probeCount: 2,
  });

  const firstPto = recovery.onTimer(325);
  assert.equal(firstPto.kind, 'pto');
  assert.equal(firstPto.ptoCount, 1);
  assert.deepEqual(firstPto.timer, {
    kind: 'pto',
    at: 650,
    space: 'application',
    ptoCount: 1,
    probeCount: 2,
  });

  recovery.sendPacket({
    space: 'application',
    now: 325,
    frames: [packetFrame('stream-1')],
    overheadBytes: 10,
  });
  // One copy of the logical frame plus two per-packet overheads.
  assert.equal(recovery.bytesInFlight, 120);
  assert.deepEqual(recovery.getTimer(), {
    kind: 'pto',
    at: 975,
    space: 'application',
    ptoCount: 1,
    probeCount: 2,
  });

  const secondPto = recovery.onTimer(975);
  assert.equal(secondPto.kind, 'pto');
  assert.equal(secondPto.ptoCount, 2);
  assert.deepEqual(secondPto.timer, {
    kind: 'pto',
    at: 1625,
    space: 'application',
    ptoCount: 2,
    probeCount: 2,
  });

  recovery.sendPacket({
    space: 'application',
    now: 975,
    frames: [packetFrame('stream-1')],
    overheadBytes: 10,
  });
  assert.equal(recovery.bytesInFlight, 130);
  assert.deepEqual(
    recovery.getInFlightFrames('application').map((frame) => ({
      id: frame.id,
      size: frame.size,
      copies: frame.copies,
    })),
    [{ id: 'stream-1', size: 100, copies: [0, 1, 2] }],
  );

  const ack = recovery.onAckReceived({
    space: 'application',
    now: 1000,
    ranges: [{ smallest: 0, largest: 0 }],
  });
  assert.equal(ack.rttSample, 1000);
  assert.equal(ack.bytesInFlight, 20);
  assert.equal(recovery.getInFlightFrames('application').length, 0);
  assert.deepEqual(recovery.getTimer(), {
    kind: 'pto',
    at: 4000,
    space: 'application',
    ptoCount: 0,
    probeCount: 2,
  });

  recovery.onAckReceived({
    space: 'application',
    now: 1010,
    ranges: [{ smallest: 1, largest: 1 }],
  });
  assert.equal(recovery.bytesInFlight, 10);

  recovery.onAckReceived({
    space: 'application',
    now: 1020,
    ranges: [{ smallest: 2, largest: 2 }],
  });
  assert.equal(recovery.bytesInFlight, 0);
  assert.equal(recovery.getTimer(), null);
  assertConservation(recovery);
});

test('lost frame retransmission is charged exactly once', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: true,
  });

  for (let packetNumber = 0; packetNumber < 4; packetNumber += 1) {
    recovery.sendPacket({
      space: 'application',
      now: packetNumber,
      frames: [packetFrame(`f${packetNumber}`)],
    });
  }

  const ack = recovery.onAckReceived({
    space: 'application',
    now: 20,
    ranges: [{ smallest: 3, largest: 3 }],
  });
  assert.deepEqual(
    ack.lost.map((packet) => packet.packetNumber),
    [0],
  );
  assert.equal(ack.lost[0].frames[0].id, 'f0');
  assert.equal(recovery.bytesInFlight, 200);
  assertConservation(recovery);

  recovery.sendPacket({
    space: 'application',
    now: 20,
    frames: [packetFrame('f0')],
  });

  assert.equal(recovery.bytesInFlight, 300);
  assert.deepEqual(
    recovery
      .getInFlightFrames('application')
      .map((frame) => frame.id)
      .sort(),
    ['f0', 'f1', 'f2'],
  );
  assertConservation(recovery);
});

test('losing duplicate frame copies decrements in-flight bytes once', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: true,
  });

  recovery.sendPacket({
    space: 'application',
    now: 0,
    frames: [packetFrame('duplicate')],
  });
  recovery.sendPacket({
    space: 'application',
    now: 1,
    frames: [packetFrame('duplicate')],
  });
  recovery.sendPacket({
    space: 'application',
    now: 2,
    frames: [packetFrame('other')],
  });
  recovery.sendPacket({
    space: 'application',
    now: 3,
    frames: [packetFrame('acked')],
  });

  // The two copies of "duplicate" are one logical frame.
  assert.equal(recovery.bytesInFlight, 300);

  recovery.onAckReceived({
    space: 'application',
    now: 20,
    ranges: [{ smallest: 3, largest: 3 }],
  });
  assert.equal(recovery.bytesInFlight, 200);

  // Packet 0 is lost first, but packet 1 still carries the frame.  Losing
  // packet 1 must release its bytes exactly once.
  assert.equal(
    recovery.getInFlightFrames('application').find(
      (frame) => frame.id === 'duplicate',
    ).copies.length,
    1,
  );
  const lost = recovery.detectLostPackets('application', 21);
  assert.deepEqual(
    lost.map((packet) => packet.packetNumber),
    [1],
  );
  assert.equal(recovery.bytesInFlight, 100);
  assert.deepEqual(
    recovery.getInFlightFrames('application').map((frame) => frame.id),
    ['other'],
  );
  assertConservation(recovery);
});

test('loss timer has priority over an earlier PTO in another space', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    granularity: 1,
    handshakeConfirmed: false,
    packetThreshold: 3,
  });

  recovery.sendPacket({
    space: 'handshake',
    now: 0,
    frames: [packetFrame('handshake-crypto', 80)],
  });
  recovery.sendPacket({
    space: 'application',
    now: 200,
    frames: [packetFrame('stream-a')],
  });
  recovery.sendPacket({
    space: 'application',
    now: 200,
    frames: [
      {
        id: 'ack-only',
        size: 0,
        ackEliciting: false,
        retransmittable: false,
      },
    ],
  });

  recovery.onAckReceived({
    space: 'application',
    now: 210,
    ranges: [{ smallest: 1, largest: 1 }],
  });

  // The ACK only acknowledges an ACK-only packet, so no RTT sample is taken.
  // Application packet 0 has a time-threshold deadline at t=312.5 while the
  // handshake PTO is already due at t=300.  RFC 9002 gives the armed loss
  // timer absolute priority.
  assert.deepEqual(recovery.getTimer(), {
    kind: 'loss',
    at: 312.5,
    space: 'application',
  });

  const beforeDeadline = recovery.onTimer(301);
  assert.equal(beforeDeadline.kind, 'none');
  assert.deepEqual(beforeDeadline.timer, {
    kind: 'loss',
    at: 312.5,
    space: 'application',
  });

  const lossEvent = recovery.onTimer(312.5);
  assert.equal(lossEvent.kind, 'loss');
  assert.deepEqual(
    lossEvent.lost.map((packet) => packet.packetNumber),
    [0],
  );
  assert.equal(lossEvent.lost[0].lostBy, 'time-threshold');
  assert.deepEqual(lossEvent.timer, {
    kind: 'pto',
    at: 300,
    space: 'handshake',
    ptoCount: 0,
    probeCount: 2,
  });
  assert.equal(lossEvent.bytesInFlight, 80);

  const ptoEvent = recovery.onTimer(312.5);
  assert.equal(ptoEvent.kind, 'pto');
  assert.equal(ptoEvent.space, 'handshake');
  assert.equal(ptoEvent.ptoCount, 1);
  assertConservation(recovery);
});

test('discarding a space releases its bytes and stops its timers', () => {
  const recovery = new QuicRecovery({
    initialRtt: 100,
    handshakeConfirmed: false,
  });

  recovery.sendPacket({
    space: 'initial',
    now: 0,
    frames: [packetFrame('initial', 120)],
  });
  recovery.sendPacket({
    space: 'handshake',
    now: 1,
    frames: [packetFrame('handshake', 80)],
  });
  assert.equal(recovery.bytesInFlight, 200);

  const discarded = recovery.discardSpace('initial');
  assert.equal(discarded.length, 1);
  assert.equal(recovery.getBytesInFlight('initial'), 0);
  assert.equal(recovery.bytesInFlight, 80);
  assert.deepEqual(recovery.getTimer(), {
    kind: 'pto',
    at: 301,
    space: 'handshake',
    ptoCount: 0,
    probeCount: 2,
  });
  assert.throws(
    () =>
      recovery.sendPacket({
        space: 'initial',
        now: 2,
        frames: [packetFrame('again')],
      }),
    /discarded/,
  );
  assertConservation(recovery);
});

test('retransmitting a frame with a different size is rejected', () => {
  const recovery = new QuicRecovery({ handshakeConfirmed: true });
  recovery.sendPacket({
    space: 'application',
    now: 0,
    frames: [packetFrame('stream', 100)],
  });

  assert.throws(
    () =>
      recovery.sendPacket({
        space: 'application',
        now: 1,
        frames: [packetFrame('stream', 101)],
      }),
    /different size/,
  );
  assert.equal(recovery.bytesInFlight, 100);
  assertConservation(recovery);
});
