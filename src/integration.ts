import { Rational } from "./rational";
import { TempoMap } from "./tempo-map";

/**
 * Direct-integration reference model: numerically integrate msPerBeat over
 * beats with the midpoint rule, independent of the exact cumulative-sum
 * implementation. Used to cross-check beatToMs.
 */
export function integrateMsDirect(
  map: TempoMap,
  fromBeat: Rational,
  toBeat: Rational,
  slices = 200_000,
): number {
  const from = fromBeat.toNumber();
  const to = toBeat.toNumber();
  if (to < from) throw new RangeError("integrateMsDirect: toBeat must be >= fromBeat");
  if (to === from) return 0;
  const step = (to - from) / slices;
  let acc = 0;
  for (let i = 0; i < slices; i++) {
    const mid = from + (i + 0.5) * step;
    acc += map.msPerBeatAtNumber(mid) * step;
  }
  return acc;
}

export interface IntegrationComparison {
  beat: string;
  exactMs: number;
  integratedMs: number;
  absError: number;
  relError: number;
}

export function compareWithIntegration(
  map: TempoMap,
  beats: Rational[],
  slices = 200_000,
): IntegrationComparison[] {
  return beats.map((beat) => {
    const exactMs = map.beatToMs(beat).toNumber();
    const integratedMs = integrateMsDirect(map, Rational.zero(), beat, slices);
    const absError = Math.abs(exactMs - integratedMs);
    const relError = exactMs === 0 ? absError : absError / Math.abs(exactMs);
    return { beat: beat.toString(), exactMs, integratedMs, absError, relError };
  });
}
