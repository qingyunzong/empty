// Pure derivation core: dual-stream window join + sustained-duration state machine.
//
// Semantics (all times are event-time milliseconds):
// - A sensor sample is valid on the half-open interval [ts, ts + windowMs).
// - At any instant t the join condition C(t) holds when the latest valid
//   pressure sample and the latest valid temperature sample both exceed their
//   limits (strictly greater; a value exactly equal to the limit does NOT count).
// - When C holds continuously for durationMs the interlock goes ARM at
//   runStart + durationMs (a run of exactly durationMs qualifies).
// - ARM ends (DISARM) at the first instant C becomes false.
// - A trip event while ARM produces a TRIP record (the proof link).
// - Only transitions with ts <= watermark are returned; everything beyond the
//   watermark is still provisional and stays unemitted.

const STATE_ORDER = { DISARM: 0, ARM: 1, TRIP: 2 };

function compareTransitions(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const rankDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (rankDiff !== 0) return rankDiff;
  return transitionKey(a) < transitionKey(b) ? -1 : 1;
}

export function transitionKey(rec) {
  return JSON.stringify(rec);
}

function latestValid(samples, tag, point, windowMs) {
  let best = null;
  for (const sample of samples) {
    if (sample.tag !== tag) continue;
    if (sample.ts > point) continue;
    if (sample.ts + windowMs <= point) continue;
    if (
      best === null ||
      sample.ts > best.ts ||
      (sample.ts === best.ts &&
        (sample.seq > best.seq ||
          (sample.seq === best.seq && sample.id > best.id)))
    ) {
      best = sample;
    }
  }
  return best;
}

export function conditionAt(samples, config, point) {
  const pressure = latestValid(samples, 'pressure', point, config.windowMs);
  const temperature = latestValid(samples, 'temperature', point, config.windowMs);
  return (
    pressure !== null &&
    temperature !== null &&
    pressure.value > config.pressureLimit &&
    temperature.value > config.tempLimit
  );
}

export function deriveTransitions(samples, trips, config, watermark) {
  const points = new Set();
  for (const sample of samples) {
    if (sample.ts <= watermark) points.add(sample.ts);
    const expiry = sample.ts + config.windowMs;
    if (expiry <= watermark) points.add(expiry);
  }
  const sortedPoints = [...points].sort((a, b) => a - b);

  const transitions = [];
  let runStart = null;
  const closeRun = (start, end) => {
    if (end - start >= config.durationMs) {
      transitions.push({ ts: start + config.durationMs, state: 'ARM', since: start });
      transitions.push({ ts: end, state: 'DISARM', since: start });
    }
  };

  for (const point of sortedPoints) {
    const holds = conditionAt(samples, config, point);
    if (holds && runStart === null) runStart = point;
    if (!holds && runStart !== null) {
      closeRun(runStart, point);
      runStart = null;
    }
  }
  if (runStart !== null && runStart + config.durationMs <= watermark) {
    transitions.push({ ts: runStart + config.durationMs, state: 'ARM', since: runStart });
  }

  const arms = transitions.filter((t) => t.state === 'ARM');
  const disarms = transitions.filter((t) => t.state === 'DISARM');
  for (const trip of trips) {
    if (trip.state !== 'TRIPPED') continue;
    if (trip.ts > watermark) continue;
    for (const arm of arms) {
      if (arm.ts > trip.ts) break;
      const disarm = disarms.find((d) => d.since === arm.since);
      const armEnd = disarm ? disarm.ts : Infinity;
      if (trip.ts < armEnd) {
        transitions.push({
          ts: trip.ts,
          state: 'TRIP',
          tripId: trip.id,
          channel: trip.channel,
          armTs: arm.ts,
          since: arm.since,
        });
        break;
      }
    }
  }

  transitions.sort(compareTransitions);
  return transitions;
}
