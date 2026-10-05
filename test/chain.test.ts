import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chain } from '../src/chain.js';
import { Fir } from '../src/fir.js';
import { Decimator } from '../src/decimator.js';
import {
  runModel,
  type ModelDecimatorSpec,
  type ModelDecimatorSwitch,
  type ModelFirSpec,
  type ModelFirSwitch,
} from '../src/model.js';
import type { Sample } from '../src/types.js';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pushInBlocks(chain: Chain, input: number[], sizes: number[]): Sample[] {
  const out: Sample[] = [];
  let i = 0;
  let b = 0;
  while (i < input.length) {
    const sz = sizes[b % sizes.length];
    out.push(...chain.push(input.slice(i, i + sz)));
    i += sz;
    b++;
  }
  return out;
}

test('block boundaries never reset state', () => {
  const input = Array.from({ length: 500 }, (_, i) => ((i * 37 + 11) % 61) - 30);
  const make = () =>
    new Chain([
      new Fir({ coeffs: [3, -1, 2, 0, 1] }),
      new Decimator({ factor: 3, phase: 1 }),
      new Fir({ coeffs: [1, 1, 1, 1, 1] }),
    ]);
  const oneShot = make().push(input);
  const blocked = pushInBlocks(make(), input, [1, 2, 7, 64, 3, 128]);
  const singles = pushInBlocks(make(), input, [1]);
  assert.deepEqual(blocked, oneShot);
  assert.deepEqual(singles, oneShot);
});

test('streaming chain matches the independent per-sample model', () => {
  const rand = lcg(20261005);
  const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let trial = 0; trial < 80; trial++) {
    const len = ri(50, 300);
    const input = Array.from({ length: len }, () => ri(-99, 99));

    const c1 = Array.from({ length: ri(1, 7) }, () => ri(-4, 4));
    const fir1 = new Fir({ coeffs: c1 });
    const switches1: ModelFirSwitch[] = [];
    for (let s = 0, nSw = ri(0, 2); s < nSw; s++) {
      const at = ri(0, len + 20); // sometimes beyond the end of the stream
      const nc = Array.from({ length: ri(1, 6) }, () => ri(-4, 4));
      const tail = rand() < 0.5 ? ('keep' as const) : ('zero' as const);
      fir1.scheduleSwitch({ at, config: { coeffs: nc }, tail });
      switches1.push({ at, coeffs: nc, tail });
    }
    const spec1: ModelFirSpec = { kind: 'fir', coeffs: c1, switches: switches1 };

    const f = ri(1, 4);
    const ph = ri(0, f - 1);
    const dec = new Decimator({ factor: f, phase: ph });
    const switches2: ModelDecimatorSwitch[] = [];
    if (rand() < 0.5) {
      const at = ri(0, len);
      const nf = ri(1, 5);
      const nph = ri(0, nf - 1);
      dec.scheduleSwitch({ at, config: { factor: nf, phase: nph } });
      switches2.push({ at, factor: nf, phase: nph });
    }
    const spec2: ModelDecimatorSpec = {
      kind: 'decimator',
      factor: f,
      phase: ph,
      switches: switches2,
    };

    const c3 = Array.from({ length: ri(1, 5) }, () => ri(-3, 3));
    const spec3: ModelFirSpec = { kind: 'fir', coeffs: c3, switches: [] };

    const chain = new Chain([fir1, dec, new Fir({ coeffs: c3 })]);
    const got = pushInBlocks(chain, input, [ri(1, 9), ri(1, 40), 1, ri(1, 100)]);
    const want = runModel(input, [spec1, spec2, spec3]);
    assert.deepEqual(got, want, `trial ${trial}`);
  }
});

test('stage delays map to original time (impulse response)', () => {
  const chain = new Chain([
    new Fir({ coeffs: [1, 2, 3, 2, 1] }), // delay 2
    new Decimator({ factor: 2, phase: 0 }), // delay 0
    new Fir({ coeffs: [1,  1, 1] }), // delay 1 local = 2 original
  ]);
  assert.deepEqual(chain.stageDelays(), [2, 0, 2]);
  assert.equal(chain.totalDelay(), 4);
  assert.equal(chain.totalDecimation(), 2);

  const input = new Array(40).fill(0);
  input[10] = 1;
  const out = chain.push(input);
  const peak = out.reduce((a, b) => (b.value > a.value ? b : a));
  // 1+3+1: the decimated impulse response [1,3,1] summed by the last FIR
  assert.equal(peak.value, 5);
  // Delay is mapped back to original time: the response to an impulse at
  // t=10 is stamped at t=10, not at t=14 where it physically emerges.
  assert.equal(peak.time, 10);
});

test('half-sample delay of even-length filters maps to fractional time', () => {
  const chain = new Chain([new Fir({ coeffs: [1, 1] })]); // delay 0.5
  assert.equal(chain.totalDelay(), 0.5);
  const input = new Array(20).fill(0);
  input[10] = 2;
  const nonzero = chain.push(input).filter((s) => s.value !== 0);
  assert.deepEqual(
    nonzero.map((s) => [s.value, s.time]),
    [
      [2, 9.5],
      [2, 10.5],
    ],
  );
});

test('config switch takes effect exactly at the scheduled sample number', () => {
  const fir = new Fir({ coeffs: [1] });
  fir.scheduleSwitch({ at: 5, config: { coeffs: [10] } });
  const chain = new Chain([fir]);

  assert.deepEqual(
    chain.push([1, 1, 1]).map((s) => s.value),
    [1, 1, 1],
  );
  assert.deepEqual(
    chain.push([1, 1]).map((s) => s.value),
    [1, 1], // samples 3 and 4: old config still active
  );
  assert.deepEqual(
    chain.push([1, 1]).map((s) => s.value),
    [10, 10], // sample 5: new config
  );
});

test('switch scheduled beyond the stream end never applies', () => {
  const fir = new Fir({ coeffs: [2] });
  fir.scheduleSwitch({ at: 1000, config: { coeffs: [7] } });
  const chain = new Chain([fir]);
  assert.deepEqual(
    chain.push([1, 2, 3]).map((s) => s.value),
    [2, 4, 6],
  );
});

test('old-tail policy: keep mixes old samples with new coefficients', () => {
  const fir = new Fir({ coeffs: [1, 0, 0] });
  fir.scheduleSwitch({ at: 3, config: { coeffs: [1, 1, 1] }, tail: 'keep' });
  const out = new Chain([fir]).push([1, 1, 1, 1, 1, 1]);
  assert.deepEqual(
    out.map((s) => s.value),
    [0, 0, 1, 3, 3, 3],
  );
  // kept tail: the window still reaches back before the switch
  assert.equal(out[3].srcFirst, 1);
});

test('old-tail policy: zero clears the delay line at the switch', () => {
  const fir = new Fir({ coeffs: [1, 0, 0] });
  fir.scheduleSwitch({ at: 3, config: { coeffs: [1, 1, 1] }, tail: 'zero' });
  const out = new Chain([fir]).push([1, 1, 1, 1, 1, 1]);
  assert.deepEqual(
    out.map((s) => s.value),
    [0, 0, 1, 1, 2, 3],
  );
  // cleared tail: pre-switch samples no longer appear in the source range
  assert.deepEqual(
    out.slice(3).map((s) => s.srcFirst),
    [3, 3, 3],
  );
});

test('output samples report their original-input source range', () => {
  const chain = new Chain([
    new Fir({ coeffs: [1, 1, 1] }),
    new Decimator({ factor: 2, phase: 0 }),
  ]);
  const out = chain.push([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    out.map((s) => [s.value, s.srcFirst, s.srcLast]),
    [
      [0, 0, 0], // warm-up: only sample 0 in the window
      [3, 0, 2], // 0+1+2
      [9, 2, 4], // 2+3+4
      [15, 4, 6], // 4+5+6
    ],
  );
  assert.deepEqual(out.map((s) => s.time), [-1, 1, 3, 5]);
});

test('decimator switch applies at the scheduled sample, counter keeps running', () => {
  const dec = new Decimator({ factor: 2, phase: 0 });
  dec.scheduleSwitch({ at: 6, config: { factor: 3, phase: 1 } });
  const chain = new Chain([dec]);
  const out = chain.push([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(out.map((s) => s.time), [0, 2, 4, 7]);
});

test('integer arithmetic is exact within the safe-integer range', () => {
  const chain = new Chain([new Fir({ coeffs: [2 ** 10, 2 ** 10, 2 ** 10] })]);
  const out = chain.push([2 ** 40, 2 ** 40, 2 ** 40]);
  assert.deepEqual(
    out.map((s) => s.value),
    [2 ** 50, 2 ** 51, 3 * 2 ** 50],
  );
  assert.ok(out.every((s) => Number.isSafeInteger(s.value)));
});

test('non-integer coefficients, inputs and switch points are rejected', () => {
  assert.throws(() => new Fir({ coeffs: [1, 0.5] }), TypeError);
  assert.throws(() => new Decimator({ factor: 2.5 }), TypeError);
  assert.throws(() => new Chain([new Fir({ coeffs: [1] })]).push([1.5]), TypeError);
  assert.throws(
    () => new Fir({ coeffs: [1] }).scheduleSwitch({ at: 2.5, config: { coeffs: [1] } }),
    TypeError,
  );
  assert.throws(() => new Fir({ coeffs: [] }), RangeError);
  assert.throws(() => new Fir({ coeffs: [1, 2], delay: 5 }), RangeError);
  assert.throws(() => new Decimator({ factor: 2, phase: 2 }), RangeError);
});
