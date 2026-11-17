import assert from "node:assert/strict";
import { test } from "node:test";

import { DeliveryWindow, type DeliveryState } from "../src/index.ts";

type ModelState = DeliveryState | "released" | "unknown";

class BitmapModelWindow {
  readonly capacity: number;
  readonly startSeq: number;

  nextSeq: number;
  watermark: number;
  highestDelivered: number;
  inFlight = new Set<number>();
  pending: number[] = [];
  retry: number[] = [];
  queued = new Set<number>();
  states = new Map<number, DeliveryState>();
  ackedBits: boolean[] = [];
  private readonly acked = new Set<number>();

  constructor(capacity: number, startSeq = 0) {
    this.capacity = capacity;
    this.startSeq = startSeq;
    this.nextSeq = startSeq;
    this.watermark = startSeq - 1;
    this.highestDelivered = startSeq - 1;
  }

  push(): number {
    const seq = this.nextSeq++;
    this.states.set(seq, "pending");
    this.pending.push(seq);
    return seq;
  }

  poll(): number | undefined {
    while (this.retry.length > 0) {
      const seq = this.retry.shift() as number;
      if (!this.queued.delete(seq)) {
        continue;
      }
      if (this.states.get(seq) !== "in-flight") {
        continue;
      }
      return seq;
    }

    if (this.inFlight.size < this.capacity && this.pending.length > 0) {
      const seq = this.pending.shift() as number;
      this.states.set(seq, "in-flight");
      this.inFlight.add(seq);
      this.highestDelivered = Math.max(this.highestDelivered, seq);
      return seq;
    }
    return undefined;
  }

  nack(seq: number): boolean {
    if (this.states.get(seq) !== "in-flight") {
      return false;
    }
    if (this.queued.has(seq)) {
      return true;
    }
    this.queued.add(seq);
    this.retry.push(seq);
    return true;
  }

  ackSelective(seqs: readonly number[]): number[] {
    const acknowledged: number[] = [];
    for (const seq of [...new Set(seqs)].sort((a, b) => a - b)) {
      if (seq <= this.watermark) {
        continue;
      }
      this.markAcked(seq, acknowledged);
    }
    this.advance();
    return acknowledged;
  }

  ackCumulative(seq: number): number[] {
    const acknowledged: number[] = [];
    for (let current = this.watermark + 1; current <= seq; current++) {
      this.markAcked(current, acknowledged);
    }
    this.advance();
    return acknowledged;
  }

  stateOf(seq: number): ModelState {
    if (seq < this.startSeq || seq >= this.nextSeq) {
      return "unknown";
    }
    if (seq <= this.watermark) {
      return "released";
    }
    return this.states.get(seq) ?? "unknown";
  }

  expectedWatermark(): number {
    let watermark = this.startSeq - 1;
    while (this.acked.has(watermark + 1)) {
      watermark++;
    }
    return watermark;
  }

  private markAcked(seq: number, acknowledged: number[]): void {
    const state = this.states.get(seq);
    if (state === undefined || state === "acknowledged") {
      return;
    }
    if (state === "in-flight") {
      this.inFlight.delete(seq);
    }
    this.states.set(seq, "acknowledged");
    this.queued.delete(seq);
    this.ackedBits[seq - this.startSeq] = true;
    this.acked.add(seq);
    acknowledged.push(seq);
  }

  private advance(): void {
    let next = this.watermark + 1;
    while (this.states.get(next) === "acknowledged") {
      this.states.delete(next);
      next++;
    }
    this.watermark = next - 1;
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function randomSubset<T>(
  random: () => number,
  values: readonly T[],
  maximum: number,
): T[] {
  if (values.length === 0) {
    return [];
  }
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap] as T, shuffled[index] as T];
  }
  const count = 1 + Math.floor(random() * Math.min(maximum, shuffled.length));
  return shuffled.slice(0, count);
}

test("random operations match the bitmap model", () => {
  const seeds = 40;
  const steps = 500;

  for (let seed = 0; seed < seeds; seed++) {
    const random = mulberry32(seed);
    const startSeq = seed % 7;
    const capacity = 1 + (seed % 8);
    const window = new DeliveryWindow<string>({
      capacity,
      startSeq,
      maxBuffered: 200,
    });
    const model = new BitmapModelWindow(capacity, startSeq);

    const values = new Map<number, string>();
    const firstDelivered = new Set<number>();
    const deliveryCounts = new Map<number, number>();
    const ackedAt = new Map<number, number>();
    let previousWatermark = model.watermark;

    const compareState = (label: string): void => {
      assert.equal(
        window.watermark,
        model.expectedWatermark(),
        `${label}: bitmap watermark (seed ${seed})`,
      );
      assert.equal(window.watermark, model.watermark, `${label}: model watermark`);
      assert.ok(window.watermark >= previousWatermark, `${label}: watermark regressed`);
      previousWatermark = window.watermark;
      assert.equal(window.inFlight, model.inFlight.size, `${label}: in-flight`);
      assert.equal(window.buffered, model.pending.length, `${label}: buffered`);
      assert.equal(window.nextSeq, model.nextSeq, `${label}: next seq`);
      assert.equal(
        window.highestDelivered,
        model.highestDelivered,
        `${label}: highest delivered`,
      );
      assert.ok(
        window.inFlight <= capacity,
        `${label}: capacity exceeded (${window.inFlight}/${capacity})`,
      );

      for (let seq = startSeq; seq < model.nextSeq; seq++) {
        assert.equal(
          window.stateOf(seq),
          model.stateOf(seq),
          `${label}: state of ${seq}`,
        );
        if (window.stateOf(seq) === "released") {
          assert.ok(
            model.ackedBits[seq - startSeq],
            `${label}: seq ${seq} released before acknowledgement`,
          );
        }
      }
    };

    const recordDelivery = (
      delivery: { seq: number; value: string; attempt: number; redelivered: boolean },
      label: string,
    ): void => {
      assert.equal(delivery.value, values.get(delivery.seq), `${label}: payload`);
      const count = (deliveryCounts.get(delivery.seq) ?? 0) + 1;
      deliveryCounts.set(delivery.seq, count);
      assert.equal(delivery.attempt, count, `${label}: attempt number`);
      assert.equal(delivery.redelivered, count > 1, `${label}: redelivery flag`);
      assert.ok(!ackedAt.has(delivery.seq), `${label}: acked seq redelivered`);

      if (count === 1) {
        assert.ok(
          !firstDelivered.has(delivery.seq),
          `${label}: duplicate first delivery`,
        );
        firstDelivered.add(delivery.seq);
      }
    };

    for (let step = 0; step < steps; step++) {
      const label = `seed ${seed} step ${step}`;
      const choice = random();

      if (choice < 0.32) {
        const count = 1 + Math.floor(random() * 3);
        for (let index = 0; index < count; index++) {
          const value = `v${model.nextSeq}`;
          const actualSeq = window.tryPush(value);
          if (actualSeq === null) {
            assert.equal(window.buffered, 200, `${label}: full buffer rejected`);
          } else {
            const modelSeq = model.push();
            assert.equal(actualSeq, modelSeq, `${label}: assigned seq`);
            values.set(actualSeq, value);
          }
        }
      } else if (choice < 0.62) {
        const count = 1 + Math.floor(random() * 3);
        for (let index = 0; index < count; index++) {
          const expectedSeq = model.poll();
          const actual = window.poll();
          if (expectedSeq === undefined) {
            assert.equal(actual, undefined, `${label}: unexpected delivery`);
          } else {
            assert.ok(actual, `${label}: missing delivery ${expectedSeq}`);
            assert.equal(actual.seq, expectedSeq, `${label}: delivery order`);
            recordDelivery(actual, label);
          }
        }
      } else if (choice < 0.78) {
        const candidates = [...model.inFlight];
        if (candidates.length > 0) {
          const seq = pick(random, candidates);
          const before = window.inFlight;
          const actual = window.nack(seq);
          const expected = model.nack(seq);
          assert.equal(actual, expected, `${label}: nack result`);
          assert.equal(
            window.inFlight,
            before,
            `${label}: nack changed in-flight quota`,
          );
        }
      } else if (choice < 0.94) {
        const candidates = [...model.inFlight];
        if (candidates.length > 0) {
          const selected = randomSubset(random, candidates, 3);
          const beforeWatermark = model.watermark;
          const actual = window.ackSelective(selected);
          const expected = model.ackSelective(selected);
          assert.deepEqual(actual.acknowledged, expected, `${label}: selective ack`);
          assert.equal(
            actual.watermark,
            model.watermark,
            `${label}: selective watermark`,
          );
          assert.equal(
            actual.released,
            model.watermark - beforeWatermark,
            `${label}: selective release count`,
          );
          for (const seq of expected) {
            ackedAt.set(seq, step);
            assert.ok(
              window.stateOf(seq) === "released" ||
                window.stateOf(seq) === "acknowledged",
              `${label}: acked state`,
            );
          }
        }
      } else if (model.highestDelivered >= startSeq) {
        const seq =
          model.highestDelivered -
          Math.floor(random() * (model.highestDelivered - startSeq + 1));
        const beforeWatermark = model.watermark;
        const actual = window.ackCumulative(seq);
        const expected = model.ackCumulative(seq);
        assert.deepEqual(actual.acknowledged, expected, `${label}: cumulative ack`);
        assert.equal(actual.watermark, model.watermark, `${label}: cumulative watermark`);
        assert.equal(
          actual.released,
          model.watermark - beforeWatermark,
          `${label}: cumulative release count`,
        );
        for (const acknowledged of expected) {
          ackedAt.set(acknowledged, step);
        }
      }

      compareState(label);
    }

    const initiallyInFlight = [...model.inFlight].sort((left, right) => left - right);
    if (initiallyInFlight.length > 0) {
      const beforeWatermark = model.watermark;
      const actualAck = window.ackSelective(initiallyInFlight);
      const expectedAck = model.ackSelective(initiallyInFlight);
      assert.deepEqual(
        actualAck.acknowledged,
        expectedAck,
        `seed ${seed}: final in-flight ack`,
      );
      assert.equal(
        actualAck.released,
        model.watermark - beforeWatermark,
        `seed ${seed}: final in-flight release`,
      );
      for (const seq of expectedAck) {
        ackedAt.set(seq, steps);
      }
      compareState(`seed ${seed}: final in-flight ack`);
    }

    for (let iteration = 0; iteration < 10_000; iteration++) {
      const expectedSeq = model.poll();
      const actual = window.poll();
      if (expectedSeq === undefined) {
        assert.equal(actual, undefined, `seed ${seed}: drain poll`);
        break;
      }
      assert.ok(actual, `seed ${seed}: drain missing ${expectedSeq}`);
      assert.equal(actual.seq, expectedSeq, `seed ${seed}: drain order`);
      recordDelivery(actual, `seed ${seed}: drain`);

      const expectedAck = model.ackSelective([actual.seq]);
      const actualAck = window.ackSelective(actual.seq);
      assert.deepEqual(actualAck.acknowledged, expectedAck, `seed ${seed}: drain ack`);
      ackedAt.set(actual.seq, steps);
      compareState(`seed ${seed}: drain`);
    }

    const lastSeq = model.nextSeq - 1;
    assert.equal(model.pending.length, 0, `seed ${seed}: pending drained`);
    assert.equal(model.inFlight.size, 0, `seed ${seed}: in-flight drained`);
    assert.equal(window.inFlight, 0);
    assert.equal(window.buffered, 0);
    assert.equal(window.watermark, lastSeq, `seed ${seed}: all acked`);
    assert.equal(model.expectedWatermark(), lastSeq);

    assert.equal(
      firstDelivered.size,
      model.nextSeq - startSeq,
      `seed ${seed}: every pushed message delivered exactly once first`,
    );
    for (let seq = startSeq; seq <= lastSeq; seq++) {
      assert.ok(firstDelivered.has(seq), `seed ${seed}: seq ${seq} was lost`);
      assert.equal(window.stateOf(seq), "released", `seed ${seed}: seq ${seq} retained`);
    }
  }
});

test("randomised cancellation hands back exactly the retained window", () => {
  for (let seed = 0; seed < 25; seed++) {
    const random = mulberry32(10_000 + seed);
    const capacity = 1 + (seed % 5);
    const window = new DeliveryWindow<string>({
      capacity,
      maxBuffered: 100,
    });
    const model = new BitmapModelWindow(capacity);
    const values = new Map<number, string>();
    const attempts = new Map<number, number>();

    for (let step = 0; step < 120; step++) {
      const choice = random();
      if (choice < 0.45) {
        const seq = window.push(`v${model.nextSeq}`);
        const modelSeq = model.push();
        assert.equal(seq, modelSeq);
        values.set(seq, `v${seq}`);
      } else if (choice < 0.8) {
        const expected = model.poll();
        const actual = window.poll();
        assert.equal(actual?.seq, expected);
        if (expected !== undefined) {
          attempts.set(expected, (attempts.get(expected) ?? 0) + 1);
        }
      } else if (choice < 0.9) {
        const candidates = [...model.inFlight];
        if (candidates.length > 0) {
          const seq = pick(random, candidates);
          assert.equal(window.nack(seq), model.nack(seq));
        }
      } else {
        const candidates = [...model.inFlight];
        if (candidates.length > 0) {
          const selected = randomSubset(random, candidates, 2);
          window.ackSelective(selected);
          model.ackSelective(selected);
        }
      }
    }

    const expectedRetained: Array<{
      seq: number;
      value: string;
      attempts: number;
      state: DeliveryState;
    }> = [];
    for (let seq = model.watermark + 1; seq < model.nextSeq; seq++) {
      const state = model.states.get(seq);
      assert.ok(state, `model state for ${seq}`);
      expectedRetained.push({
        seq,
        value: values.get(seq) as string,
        attempts: attempts.get(seq) ?? 0,
        state,
      });
    }

    const report = window.cancel(`seed-${seed}`);
    assert.equal(report.reason, `seed-${seed}`);
    assert.equal(report.watermark, model.watermark);
    assert.deepEqual(report.retained, expectedRetained);
    assert.equal(window.inFlight, 0);
    assert.equal(window.buffered, 0);
    assert.equal(window.poll(), undefined);
  }
});
