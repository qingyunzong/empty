// Splits a shipment window into temperature segments bounded by the
// shipment in/out times and the sensor readings. A segment longer than
// max_gap_seconds is classified UNKNOWN (no trustworthy coverage) and is
// never counted as an excursion.
export function computeBatchReport(shipment, adjustedReadings) {
  const inMs = shipment.in_ms;
  const outMs = shipment.out_ms;
  const maxGapMs = shipment.max_gap_seconds * 1000;
  const points = adjustedReadings
    .filter((r) => r.sensor_id === shipment.sensor_id && r.ts_ms >= inMs && r.ts_ms <= outMs)
    .sort((a, b) => a.ts_ms - b.ts_ms);

  const rawSegments = [];
  if (points.length === 0) {
    rawSegments.push({ start_ms: inMs, end_ms: outMs, temp_c: null });
  } else {
    if (points[0].ts_ms > inMs) {
      rawSegments.push({ start_ms: inMs, end_ms: points[0].ts_ms, temp_c: points[0].temp_c });
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      rawSegments.push({ start_ms: points[i].ts_ms, end_ms: points[i + 1].ts_ms, temp_c: points[i].temp_c });
    }
    const last = points[points.length - 1];
    if (last.ts_ms < outMs) {
      rawSegments.push({ start_ms: last.ts_ms, end_ms: outMs, temp_c: last.temp_c });
    }
  }

  let excursionMs = 0;
  let unknownMs = 0;
  const segments = rawSegments
    .filter((seg) => seg.end_ms > seg.start_ms)
    .map((seg) => {
      const durationMs = seg.end_ms - seg.start_ms;
      const unknown = seg.temp_c === null || durationMs > maxGapMs;
      const excursion =
        !unknown && (seg.temp_c < shipment.min_temp_c || seg.temp_c > shipment.max_temp_c);
      const klass = unknown ? 'UNKNOWN' : excursion ? 'EXCURSION' : 'OK';
      if (unknown) unknownMs += durationMs;
      else if (excursion) excursionMs += durationMs;
      return {
        start: new Date(seg.start_ms).toISOString(),
        end: new Date(seg.end_ms).toISOString(),
        seconds: durationMs / 1000,
        temp_c: seg.temp_c,
        class: klass,
      };
    });

  const totalMs = outMs - inMs;
  const status = excursionMs > 0 ? 'NON_COMPLIANT' : unknownMs > 0 ? 'UNKNOWN' : 'COMPLIANT';
  return {
    batch_id: shipment.batch_id,
    sensor_id: shipment.sensor_id,
    readings_in_window: points.length,
    excursion_seconds: excursionMs / 1000,
    unknown_seconds: unknownMs / 1000,
    evaluated_seconds: (totalMs - unknownMs) / 1000,
    total_seconds: totalMs / 1000,
    status,
    segments,
  };
}
