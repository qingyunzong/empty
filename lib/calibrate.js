const round6 = (x) => Math.round(x * 1e6) / 1e6;

// Applies calibration offsets to raw readings. Never mutates the input:
// every returned reading keeps `raw_temp_c` alongside the calibrated
// `temp_c`. Because calibration always starts from the raw readings,
// replaying the same adjustment set is idempotent.
export function applyAdjustments(readings, adjustments) {
  const bySensor = new Map();
  for (const adj of adjustments) {
    if (!bySensor.has(adj.sensor_id)) bySensor.set(adj.sensor_id, []);
    bySensor.get(adj.sensor_id).push(adj);
  }
  return readings.map((reading) => {
    const tsMs = reading.ts_ms ?? Date.parse(reading.ts);
    let offset = 0;
    let applied = 0;
    for (const adj of bySensor.get(reading.sensor_id) ?? []) {
      if (tsMs >= adj.start_ms && tsMs <= adj.end_ms) {
        offset += adj.offset_c;
        applied += 1;
      }
    }
    return {
      sensor_id: reading.sensor_id,
      ts: reading.ts,
      ts_ms: tsMs,
      raw_temp_c: reading.temp_c,
      temp_c: applied === 0 ? reading.temp_c : round6(reading.temp_c + offset),
      adjustments_applied: applied,
    };
  });
}
