import { Fraction } from "./fraction";
import { TempoMap, MS_PER_MINUTE } from "./tempoMap";

export interface SegmentCert {
  index: number;
  startBeat: string;
  endBeat: string | null;
  bpm: string;
  msPerBeat: string;
  startMs: string;
  endMs: string | null;
}

export interface RoundTripCert {
  beat: string;
  ms: string;
  backBeat: string;
  ok: boolean;
}

export interface InverseRoundTripCert {
  ms: string;
  beat: string;
  backMs: string;
  ok: boolean;
}

export interface IntegrationCert {
  direction: "beats->ms" | "ms->beats";
  samples: number;
  stepsPerSpan: number;
  maxAbsError: number;
  tolerance: number;
  ok: boolean;
}

export interface MappingCertificate {
  kind: "tempo-map-bidirectional-certificate";
  segments: SegmentCert[];
  roundTrips: RoundTripCert[];
  inverseRoundTrips: InverseRoundTripCert[];
  integration: IntegrationCert[];
  allPassed: boolean;
}

/**
 * Direct float64 integration model (independent of the rational map):
 * ms(b) = integral of 60000 / bpm(u) du over [0, b], integrated segment
 * by segment with the midpoint rule. Only segment boundaries and bpm
 * values are taken from the map; all accumulation is plain float64.
 */
export function integrateBeatsToMs(map: TempoMap, targetBeat: number, stepsPerBeat = 5000): number {
  let acc = 0;
  for (const s of map.segments()) {
    const start = s.startBeat.toNumber();
    if (targetBeat <= start) break;
    const segEnd = s.endBeat === null ? Infinity : s.endBeat.toNumber();
    const end = Math.min(segEnd, targetBeat);
    const span = end - start;
    const steps = Math.max(1, Math.round(span * stepsPerBeat));
    const h = span / steps;
    const rate = MS_PER_MINUTE / s.bpm.toNumber();
    for (let k = 0; k < steps; k++) {
      acc += rate * h; // midpoint rule; bpm constant within the segment
    }
  }
  return acc;
}

/**
 * Direct float64 integration model for the inverse:
 * beat(t) = integral of bpm(s) / 60000 ds over [0, t]. Segment time
 * spans are accumulated in float64 as the walk proceeds.
 */
export function integrateMsToBeats(map: TempoMap, targetMs: number, stepsPerBeat = 5000): number {
  let acc = 0;
  let segStartMs = 0;
  for (const s of map.segments()) {
    if (targetMs <= segStartMs) break;
    const beatSpan = s.endBeat === null ? Infinity : s.endBeat.sub(s.startBeat).toNumber();
    const segSpanMs = beatSpan * s.msPerBeat.toNumber();
    const end = Math.min(segStartMs + segSpanMs, targetMs);
    const span = end - segStartMs;
    const steps = Math.max(1, Math.round((span / s.msPerBeat.toNumber()) * stepsPerBeat));
    const h = span / steps;
    const rate = s.bpm.toNumber() / MS_PER_MINUTE;
    for (let k = 0; k < steps; k++) {
      acc += rate * h;
    }
    segStartMs += segSpanMs;
  }
  return acc;
}

const INTEGRATION_STEPS_PER_BEAT = 5000;
const TOLERANCE = 1e-6;

/** Build a bidirectional mapping certificate for the map and its events. */
export function buildCertificate(map: TempoMap): MappingCertificate {
  const segments: SegmentCert[] = map.segments().map((s) => ({
    index: s.index,
    startBeat: s.startBeat.toString(),
    endBeat: s.endBeat === null ? null : s.endBeat.toString(),
    bpm: s.bpm.toString(),
    msPerBeat: s.msPerBeat.toString(),
    startMs: s.startMs.toString(),
    endMs: s.endMs === null ? null : s.endMs.toString(),
  }));

  // Sample points: segment boundaries, segment midpoints, and event beats.
  const samples = new Map<string, Fraction>();
  const addSample = (b: Fraction) => samples.set(b.toString(), b);
  for (const s of map.segments()) {
    addSample(s.startBeat);
    if (s.endBeat !== null) {
      addSample(s.endBeat);
      addSample(s.startBeat.add(s.endBeat).div(Fraction.of(2)));
    }
  }
  for (const e of map.eventList) addSample(e.beat);
  const beats = [...samples.values()].sort((a, b) => a.cmp(b));

  const roundTrips: RoundTripCert[] = beats.map((b) => {
    const ms = map.beatsToMs(b);
    const back = map.msToBeats(ms);
    return { beat: b.toString(), ms: ms.toString(), backBeat: back.toString(), ok: back.eq(b) };
  });

  const inverseRoundTrips: InverseRoundTripCert[] = beats.map((b) => {
    const ms = map.beatsToMs(b);
    const back = map.beatsToMs(map.msToBeats(ms));
    return { ms: ms.toString(), beat: map.msToBeats(ms).toString(), backMs: back.toString(), ok: back.eq(ms) };
  });

  const integration: IntegrationCert[] = [];

  let maxFwd = 0;
  for (const b of beats) {
    const exact = map.beatsToMs(b).toNumber();
    const numeric = integrateBeatsToMs(map, b.toNumber(), INTEGRATION_STEPS_PER_BEAT);
    maxFwd = Math.max(maxFwd, Math.abs(exact - numeric));
  }
  integration.push({
    direction: "beats->ms",
    samples: beats.length,
    stepsPerSpan: INTEGRATION_STEPS_PER_BEAT,
    maxAbsError: maxFwd,
    tolerance: TOLERANCE,
    ok: maxFwd <= TOLERANCE,
  });

  let maxInv = 0;
  for (const b of beats) {
    const ms = map.beatsToMs(b);
    const exact = map.msToBeats(ms).toNumber();
    const numeric = integrateMsToBeats(map, ms.toNumber(), INTEGRATION_STEPS_PER_BEAT);
    maxInv = Math.max(maxInv, Math.abs(exact - numeric));
  }
  integration.push({
    direction: "ms->beats",
    samples: beats.length,
    stepsPerSpan: INTEGRATION_STEPS_PER_BEAT,
    maxAbsError: maxInv,
    tolerance: TOLERANCE,
    ok: maxInv <= TOLERANCE,
  });

  const allPassed =
    roundTrips.every((r) => r.ok) &&
    inverseRoundTrips.every((r) => r.ok) &&
    integration.every((r) => r.ok);

  return {
    kind: "tempo-map-bidirectional-certificate",
    segments,
    roundTrips,
    inverseRoundTrips,
    integration,
    allPassed,
  };
}
