import { Sample, StageConfig, TailPolicy } from './sample';

/**
 * Independent per-sample reference model, used to cross-check the streaming
 * Chain. It is deliberately naive: whole-signal arrays, direct convolution
 * per output sample, no streaming state, no shared code with src/stages.ts.
 */

export interface ReferenceSegment {
  readonly config: readonly StageConfig[];
  readonly input: readonly number[];
}

function refFir(taps: readonly number[], flush: boolean, input: readonly Sample[]): Sample[] {
  if (taps.length === 0 || taps.length % 2 === 0) throw new Error('ref fir: taps must be non-empty and odd length');
  for (let k = 0; k < taps.length; k++) {
    if (!Number.isInteger(taps[k]!)) throw new Error('ref fir: taps must be integers');
    if (taps[k] !== taps[taps.length - 1 - k]!) throw new Error('ref fir: taps must be symmetric');
  }
  if (input.length === 0) return [];
  const m = taps.length;
  const d = (m - 1) / 2;
  const step = input.length >= 2 ? input[input.length - 1]!.center - input[input.length - 2]!.center : 1;
  const ext: Sample[] = input.slice();
  if (flush) {
    const base = input[input.length - 1]!.center;
    for (let i = 1; i <= m - 1; i++) {
      ext.push({ value: 0, first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY, center: base + i * step });
    }
  }
  const out: Sample[] = [];
  for (let n = m - 1; n < ext.length; n++) {
    let acc = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < m; k++) {
      const s = ext[n - k]!;
      acc += taps[k]! * s.value;
      if (s.first < first) first = s.first;
      if (s.last > last) last = s.last;
    }
    out.push({ value: acc, first, last, center: ext[n - d]!.center });
  }
  return out;
}

function refDecimate(factor: number, phase: number, input: readonly Sample[]): Sample[] {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('ref decimate: bad factor');
  if (!Number.isInteger(phase) || phase < 0 || phase >= factor) throw new Error('ref decimate: bad phase');
  const out: Sample[] = [];
  for (let i = 0; i < input.length; i++) {
    if (i % factor === phase) out.push(input[i]!);
  }
  return out;
}

function refStage(config: StageConfig, flush: boolean, input: readonly Sample[]): Sample[] {
  return config.kind === 'fir'
    ? refFir(config.taps, flush, input)
    : refDecimate(config.factor, config.phase ?? 0, input);
}

/**
 * Run the reference model over one or more segments. Each segment is
 * processed with fresh state (this models a configuration switch: the new
 * config starts empty, the old tail is dropped or zero-pad-flushed per
 * `tailPolicy`). `startIndex` is the original-time index of the first input
 * sample of the first segment.
 */
export function runReference(
  segments: readonly ReferenceSegment[],
  tailPolicy: TailPolicy,
  startIndex = 0,
): Sample[] {
  const out: Sample[] = [];
  let index = startIndex;
  for (const seg of segments) {
    let current: Sample[] = seg.input.map((value, i) => {
      if (!Number.isInteger(value)) throw new Error('ref: input samples must be integers');
      const at = index + i;
      return { value, first: at, last: at, center: at };
    });
    index += seg.input.length;
    for (const stage of seg.config) current = refStage(stage, tailPolicy === 'flush', current);
    out.push(...current);
  }
  return out;
}
