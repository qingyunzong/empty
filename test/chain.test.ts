import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chain, Sample, StageConfig, TailPolicy, runReference } from '../src/index';

// Deterministic PRNG (LCG) so the tests need no dependencies.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function randomConfig(rand: () => number): StageConfig[] {
  const config: StageConfig[] = [];
  const nStages = randInt(rand, 1, 3);
  for (let i = 0; i < nStages; i++) {
    if (rand() < 0.6) {
      const half = randInt(rand, 0, 3); // length 1, 3, 5 or 7
      const left = Array.from({ length: half }, () => randInt(rand, -8, 8));
      const taps = [...left, randInt(rand, -8, 8), ...left.slice().reverse()];
      config.push({ kind: 'fir', taps });
    } else {
      const factor = randInt(rand, 1, 4);
      config.push({ kind: 'decimate', factor, phase: randInt(rand, 0, factor - 1) });
    }
  }
  return config;
}

function randomInput(rand: () => number, maxLen: number): number[] {
  return Array.from({ length: randInt(rand, 0, maxLen) }, () => randInt(rand, -50, 50));
}

interface Segment {
  config: StageConfig[];
  input: number[];
}

/** Drive the streaming chain segment by segment with random block sizes. */
function runChain(segments: Segment[], policy: TailPolicy, rand: () => number): Sample[] {
  const chain = new Chain(segments[0]!.config, policy);
  const out: Sample[] = [];
  let consumed = 0;
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) out.push(...chain.reconfigure(segments[i]!.config, consumed));
    const input = segments[i]!.input;
    let pos = 0;
    while (pos < input.length) {
      const n = randInt(rand, 1, 7);
      out.push(...chain.push(input.slice(pos, pos + n)));
      pos += n;
    }
    consumed += input.length;
  }
  out.push(...chain.finish());
  return out;
}

test('block boundaries never reset state; output matches the independent per-sample model', () => {
  for (const policy of ['drop', 'flush'] as const) {
    for (let trial = 0; trial < 200; trial++) {
      const rand = lcg(1000 + trial);
      const segments: Segment[] = [];
      const nSeg = randInt(rand, 1, 3);
      for (let i = 0; i < nSeg; i++) {
        segments.push({ config: randomConfig(rand), input: randomInput(rand, 60) });
      }
      const streamed = runChain(segments, policy, rand);
      const expected = runReference(segments, policy);
      assert.deepEqual(streamed, expected, `policy=${policy} trial=${trial}`);
    }
  }
});

test('same input with many different blockings yields identical output', () => {
  const rand = lcg(7);
  const config = randomConfig(rand);
  const input = randomInput(rand, 120);
  const single = new Chain(config, 'flush');
  const baseline = [...single.push(input), ...single.finish()];
  for (let trial = 0; trial < 50; trial++) {
    const chunked = runChain([{ config, input }], 'flush', lcg(5000 + trial));
    assert.deepEqual(chunked, baseline, `trial=${trial}`);
  }
});

test('stage delays map to original time: center === latency + m * outPeriod', () => {
  for (let trial = 0; trial < 100; trial++) {
    const rand = lcg(20000 + trial);
    const config = randomConfig(rand);
    // Long enough to produce output even for 7-tap FIRs around 4x decimators.
    const input = randomInput(rand, 64).concat(randomInput(rand, 64), randomInput(rand, 64), randomInput(rand, 64));
    const chain = new Chain(config, 'drop');
    const out = chain.push(input);
    const { outPeriod, latency } = chain.timing();
    assert.ok(out.length > 0, `trial=${trial}: expected some output`);
    // Analytic source-range span: each FIR widens the window by (M-1) local samples.
    let period = 1;
    let span = 0;
    for (const st of config) {
      if (st.kind === 'fir') span += (st.taps.length - 1) * period;
      else period *= st.factor;
    }
    out.forEach((s, m) => {
      assert.strictEqual(s.center, latency + m * outPeriod, `trial=${trial} m=${m}`);
      assert.strictEqual(s.last - s.first, span, `trial=${trial} m=${m}`);
      assert.ok(s.first <= s.center && s.center <= s.last, `trial=${trial} m=${m}`);
    });
  }
});

test('impulse stays aligned to its original-time index through the chain', () => {
  const config: StageConfig[] = [
    { kind: 'fir', taps: [1, 2, 3, 2, 1] },
    { kind: 'decimate', factor: 2, phase: 1 },
    { kind: 'fir', taps: [4, 5, 4] },
    { kind: 'decimate', factor: 3, phase: 2 },
  ];
  const chain = new Chain(config, 'drop');
  const { outPeriod, latency } = chain.timing();
  assert.deepEqual({ outPeriod, latency }, { outPeriod: 6, latency: 9 });
  const j = 3;
  const k = latency + j * outPeriod; // impulse at original index 27
  const input = new Array<number>(64).fill(0);
  input[k] = 7;
  const out = chain.push(input);
  const hit = out[j]!;
  assert.strictEqual(hit.center, k);
  assert.ok(hit.first <= k && k <= hit.last);
  // The impulse reaches the output through three aligned paths:
  // 7 * (taps1[0]*taps2[0] + taps1[2]*taps2[1] + taps1[4]*taps2[2]).
  assert.strictEqual(hit.value, 7 * (1 * 4 + 3 * 5 + 1 * 4));
});

test('flush tail: zero-padded old tail, extrapolated centers, ranges cover real samples only', () => {
  const chain = new Chain([{ kind: 'fir', taps: [1, 2, 1] }], 'flush');
  const body = chain.push([1, 2, 3, 4, 5]);
  const tail = chain.finish();
  const out = [...body, ...tail];
  assert.strictEqual(out.length, 5); // one output per input sample
  assert.deepEqual(out.map((s) => s.center), [1, 2, 3, 4, 5]);
  assert.deepEqual(out.map((s) => s.value), [8, 12, 16, 14, 5]);
  assert.deepEqual(out.map((s) => [s.first, s.last]), [
    [0, 2],
    [1, 3],
    [2, 4],
    [3, 4],
    [4, 4], // flushed tail: zero padding does not extend the source range
  ]);
  assert.deepEqual(out, runReference([{ config: [{ kind: 'fir', taps: [1, 2, 1] }], input: [1, 2, 3, 4, 5] }], 'flush'));
});

test('drop tail: the last M-1 outputs are simply never emitted', () => {
  const chain = new Chain([{ kind: 'fir', taps: [1, 2, 1] }], 'drop');
  const body = chain.push([1, 2, 3, 4, 5]);
  assert.deepEqual(chain.finish(), []);
  assert.deepEqual(body.map((s) => s.center), [1, 2, 3]);
  assert.deepEqual(body.map((s) => s.value), [8, 12, 16]);
});

test('config switch takes effect only at the explicit sample number', () => {
  const oldConfig: StageConfig[] = [{ kind: 'fir', taps: [1, 1, 1] }];
  const newConfig: StageConfig[] = [{ kind: 'fir', taps: [1, 0, 1] }];
  const input = [1, 2, 3, 4, 5, 6];
  const chain = new Chain(oldConfig, 'flush');
  const a = chain.push(input.slice(0, 3));
  const tail = chain.reconfigure(newConfig, 3); // switch exactly at sample #3
  const b = chain.push(input.slice(3));
  const end = chain.finish();
  const got = [...a, ...tail, ...b, ...end];
  const expected = runReference(
    [
      { config: oldConfig, input: input.slice(0, 3) },
      { config: newConfig, input: input.slice(3) },
    ],
    'flush',
  );
  assert.deepEqual(got, expected);
  // Old tail uses the OLD coefficients: center 2 sees x1,x2,0 -> 2+3+0 = 5,
  // center 3 sees x2,0,0 -> 3.
  assert.deepEqual(tail.map((s) => s.value), [5, 3]);
  // New config starts with fresh state: first new output is centered at 4.
  assert.strictEqual(b[0]!.center, 4);
  assert.strictEqual(b[0]!.value, 1 * 4 + 0 * 5 + 1 * 6);
});

test('invalid configurations and misuse are rejected', () => {
  assert.throws(() => new Chain([], 'drop'), /at least one stage/);
  assert.throws(() => new Chain([{ kind: 'fir', taps: [1, 1] }]), /odd length/);
  assert.throws(() => new Chain([{ kind: 'fir', taps: [1, 2, 3] }]), /symmetric/);
  assert.throws(() => new Chain([{ kind: 'fir', taps: [1.5, 2, 1.5] }]), /not an integer/);
  assert.throws(() => new Chain([{ kind: 'decimate', factor: 0 }]), /factor/);
  assert.throws(() => new Chain([{ kind: 'decimate', factor: 2, phase: 2 }]), /phase/);
  assert.throws(() => new Chain([{ kind: 'decimate', factor: 2.5 }]), /factor/);

  const chain = new Chain([{ kind: 'fir', taps: [1, 2, 1] }], 'drop');
  assert.throws(() => chain.push([1.5]), /not an integer/);
  chain.push([1, 2, 3]);
  assert.throws(() => chain.reconfigure([{ kind: 'fir', taps: [1, 2, 1] }], 2), /explicit sample number/);
  assert.throws(() => chain.reconfigure([{ kind: 'fir', taps: [1, 2, 1] }], 4), /explicit sample number/);
  chain.reconfigure([{ kind: 'fir', taps: [1, 2, 1] }], 3); // exact sample number: ok
  chain.finish();
  assert.throws(() => chain.push([1]), /after finish/);
  assert.throws(() => chain.finish(), /twice/);
  assert.throws(() => chain.reconfigure([{ kind: 'fir', taps: [1, 2, 1] }], 3), /after finish/);
});
