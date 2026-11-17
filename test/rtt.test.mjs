import assert from 'node:assert/strict';
import test from 'node:test';
import { RttEstimator } from '../build/src/index.js';
import { assertClose } from './helpers.mjs';

test('first RTT sample initializes min, smoothed and variance directly', () => {
  const rtt = new RttEstimator({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
  });

  assert.equal(rtt.hasSample, false);
  assert.equal(rtt.ptoBase, 300);

  rtt.update(80, 50, true);

  assert.equal(rtt.latestRtt, 80);
  assert.equal(rtt.minRtt, 80);
  assert.equal(rtt.smoothedRtt, 80);
  assert.equal(rtt.rttvar, 40);
});

test('ACK delay is capped and only subtracted above min_rtt', () => {
  const rtt = new RttEstimator({
    initialRtt: 100,
    granularity: 1,
    maxAckDelay: 25,
    timeThreshold: 9 / 8,
  });

  rtt.update(100, 0, true);
  rtt.update(150, 80, true);

  assertClose(rtt.smoothedRtt, 103.125);
  assertClose(rtt.rttvar, 43.75);
  assert.equal(rtt.minRtt, 100);
  assertClose(rtt.lossDelay, 168.75);
});

test('ACK delay below min_rtt is not subtracted', () => {
  const rtt = new RttEstimator({
    initialRtt: 100,
    maxAckDelay: 25,
  });

  rtt.update(100, 0, true);
  rtt.update(110, 20, true);

  assertClose(rtt.smoothedRtt, 101.25);
  assertClose(rtt.rttvar, 40);
});

test('RTT estimator rejects invalid values', () => {
  assert.throws(
    () => new RttEstimator({ initialRtt: -1 }),
    /finite non-negative/,
  );
  assert.throws(
    () => new RttEstimator({ granularity: 0 }),
    /greater than zero/,
  );

  const rtt = new RttEstimator();
  assert.throws(() => rtt.update(-1, 0, false), /finite non-negative/);
});
