import { Rational } from "./rational";
import { TempoMap } from "./tempo-map";

export interface SegmentCertificate {
  startBeat: string;
  msPerBeat: string;
  startMs: string;
}

export interface BeatToMsEntry {
  beat: string;
  ms: string;
  roundTripBeat: string;
}

export interface MsToBeatEntry {
  ms: string;
  beat: string;
  roundTripMs: string;
}

/** JSON-serializable proof artifact for the beat<->ms mapping, both directions. */
export interface MappingCertificate {
  kind: "tempo-map-certificate/v1";
  segments: SegmentCertificate[];
  beatToMs: BeatToMsEntry[];
  msToBeat: MsToBeatEntry[];
}

export interface VerificationResult {
  ok: boolean;
  failures: string[];
}

/** Deterministic sample points: every segment boundary plus midpoints between them. */
export function defaultSampleBeats(map: TempoMap): Rational[] {
  const segs = map.getSegments();
  const beats: Rational[] = [];
  for (let i = 0; i < segs.length; i++) {
    const start = segs[i]!.startBeat;
    beats.push(start);
    const end = i + 1 < segs.length ? segs[i + 1]!.startBeat : start.add(Rational.of(4));
    beats.push(start.add(end).div(Rational.of(2)));
  }
  return beats;
}

export function generateCertificate(
  map: TempoMap,
  sampleBeats: Rational[] = defaultSampleBeats(map),
): MappingCertificate {
  const segments: SegmentCertificate[] = map.getSegments().map((s) => ({
    startBeat: s.startBeat.toString(),
    msPerBeat: s.msPerBeat.toString(),
    startMs: s.startMs.toString(),
  }));

  const beatToMs: BeatToMsEntry[] = sampleBeats.map((beat) => {
    const ms = map.beatToMs(beat);
    return {
      beat: beat.toString(),
      ms: ms.toString(),
      roundTripBeat: map.msToBeat(ms).toString(),
    };
  });

  const sampleMs = sampleBeats.map((b) => map.beatToMs(b));
  const msToBeat: MsToBeatEntry[] = sampleMs.map((ms) => {
    const beat = map.msToBeat(ms);
    return {
      ms: ms.toString(),
      beat: beat.toString(),
      roundTripMs: map.beatToMs(beat).toString(),
    };
  });

  return { kind: "tempo-map-certificate/v1", segments, beatToMs, msToBeat };
}

/**
 * Re-check a certificate against a tempo map: every segment offset must match,
 * and every sample must round-trip exactly in both directions.
 */
export function verifyCertificate(map: TempoMap, cert: MappingCertificate): VerificationResult {
  const failures: string[] = [];
  if (cert.kind !== "tempo-map-certificate/v1") {
    failures.push(`unknown certificate kind: ${cert.kind}`);
    return { ok: false, failures };
  }

  cert.segments.forEach((seg, i) => {
    const startBeat = Rational.parse(seg.startBeat);
    const expected = map.beatToMs(startBeat);
    if (!expected.equals(Rational.parse(seg.startMs))) {
      failures.push(`segment ${i}: startMs ${seg.startMs} != recomputed ${expected}`);
    }
    const tempo = map.msPerBeatAt(startBeat);
    if (!tempo.equals(Rational.parse(seg.msPerBeat))) {
      failures.push(`segment ${i}: msPerBeat ${seg.msPerBeat} != recomputed ${tempo}`);
    }
  });

  cert.beatToMs.forEach((entry, i) => {
    const beat = Rational.parse(entry.beat);
    const ms = map.beatToMs(beat);
    if (!ms.equals(Rational.parse(entry.ms))) {
      failures.push(`beatToMs ${i}: ms ${entry.ms} != recomputed ${ms}`);
    }
    const back = map.msToBeat(ms);
    if (!back.equals(Rational.parse(entry.roundTripBeat))) {
      failures.push(`beatToMs ${i}: roundTripBeat ${entry.roundTripBeat} != recomputed ${back}`);
    }
    if (!back.equals(beat)) {
      failures.push(`beatToMs ${i}: round trip ${beat} -> ${ms} -> ${back} is not exact`);
    }
  });

  cert.msToBeat.forEach((entry, i) => {
    const ms = Rational.parse(entry.ms);
    const beat = map.msToBeat(ms);
    if (!beat.equals(Rational.parse(entry.beat))) {
      failures.push(`msToBeat ${i}: beat ${entry.beat} != recomputed ${beat}`);
    }
    const back = map.beatToMs(beat);
    if (!back.equals(Rational.parse(entry.roundTripMs))) {
      failures.push(`msToBeat ${i}: roundTripMs ${entry.roundTripMs} != recomputed ${back}`);
    }
    if (!back.equals(ms)) {
      failures.push(`msToBeat ${i}: round trip ${ms} -> ${beat} -> ${back} is not exact`);
    }
  });

  return { ok: failures.length === 0, failures };
}
