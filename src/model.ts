/**
 * Independent per-sample reference model.
 *
 * This module re-implements the semantics of `Chain` in a deliberately
 * different style: instead of streaming state machines it transforms whole
 * sample arrays stage by stage, computing every output sample with a direct
 * per-tap loop. It shares no code with the streaming implementation and
 * exists to be cross-checked against it in the test suite.
 */
import type { Sample, TailPolicy } from './types.js';

export interface ModelFirSwitch {
  readonly at: number;
  readonly coeffs: readonly number[];
  readonly delay?: number;
  readonly tail?: TailPolicy;
}

export interface ModelFirSpec {
  readonly kind: 'fir';
  readonly coeffs: readonly number[];
  readonly delay?: number;
  readonly switches?: readonly ModelFirSwitch[];
}

export interface ModelDecimatorSwitch {
  readonly at: number;
  readonly factor: number;
  readonly phase?: number;
}

export interface ModelDecimatorSpec {
  readonly kind: 'decimator';
  readonly factor: number;
  readonly phase?: number;
  readonly switches?: readonly ModelDecimatorSwitch[];
}

export type ModelStageSpec = ModelFirSpec | ModelDecimatorSpec;

export function runModel(
  input: readonly number[],
  specs: readonly ModelStageSpec[],
): Sample[] {
  let samples: Sample[] = input.map((v, i) => ({
    value: v,
    time: i,
    srcFirst: i,
    srcLast: i,
  }));
  for (const spec of specs) {
    samples = spec.kind === 'fir' ? firPass(samples, spec) : decimatorPass(samples, spec);
  }
  return samples;
}

function firPass(input: readonly Sample[], spec: ModelFirSpec): Sample[] {
  const switches = [...(spec.switches ?? [])].sort((a, b) => a.at - b.at);
  const out: Sample[] = [];
  let coeffs: readonly number[] = spec.coeffs;
  let delay = spec.delay ?? (spec.coeffs.length - 1) / 2;
  // Delay-line entries available before the current sample. Mirrors the
  // streaming semantics: grows by one per consumed sample up to n - 1,
  // is cleared by a 'zero' switch and truncated by a 'keep' switch.
  let histLen = 0;
  let next = 0;
  for (let k = 0; k < input.length; k++) {
    while (next < switches.length && input[k].time >= switches[next].at) {
      const sw = switches[next];
      coeffs = sw.coeffs;
      delay = sw.delay ?? (sw.coeffs.length - 1) / 2;
      histLen = (sw.tail ?? 'keep') === 'zero' ? 0 : Math.min(histLen, coeffs.length - 1);
      next++;
    }

    const n = coeffs.length;
    const lo = k - histLen; // oldest real sample in the window
    let acc = 0;
    let first = Infinity;
    for (let j = lo; j <= k; j++) {
      acc += coeffs[n - 1 - (k - j)] * input[j].value;
      if (input[j].srcFirst < first) first = input[j].srcFirst;
    }

    // Map the group delay back to original time.
    const center = k - delay;
    let time: number;
    if (center >= lo) {
      const p0 = Math.floor(center);
      const p1 = Math.ceil(center);
      const f = center - p0;
      time = input[p0].time * (1 - f) + input[p1].time * f;
    } else {
      const spacing = k >= 1 ? input[k].time - input[k - 1].time : 1;
      time = input[lo].time - (lo - center) * spacing;
    }

    out.push({
      value: acc,
      time,
      srcFirst: first === Infinity ? input[k].srcFirst : first,
      srcLast: input[k].srcLast,
    });
    histLen = Math.min(histLen + 1, n - 1);
  }
  return out;
}

function decimatorPass(input: readonly Sample[], spec: ModelDecimatorSpec): Sample[] {
  const switches = [...(spec.switches ?? [])].sort((a, b) => a.at - b.at);
  const out: Sample[] = [];
  let factor = spec.factor;
  let phase = spec.phase ?? 0;
  let next = 0;
  let count = 0;
  for (const s of input) {
    while (next < switches.length && s.time >= switches[next].at) {
      factor = switches[next].factor;
      phase = switches[next].phase ?? 0;
      next++;
    }
    if (count % factor === phase) out.push(s);
    count++;
  }
  return out;
}
