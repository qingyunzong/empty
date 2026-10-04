import { DAY_MS, dayStartMs, dayString } from './model.js';

// Reference algorithm: independently scans every log entry and rebuilds the
// bitemporal intervals from scratch. Used to cross-check the incremental
// engine and to answer historical AS OF queries.
export function rebuild(entries, asOfTxMs = Infinity) {
  const revertTime = new Map();
  for (const entry of entries) {
    if (entry.type === 'revert') revertTime.set(entry.reverted_tx_id, entry.tx_time_ms);
  }

  const byEquipment = new Map();
  let minValidMs = Infinity;
  let maxValidMs = -Infinity;
  let seq = 0;
  for (const entry of entries) {
    if (entry.type !== 'commit') continue;
    if (entry.tx_time_ms > asOfTxMs) continue;
    const revertedAt = revertTime.get(entry.tx_id);
    if (revertedAt !== undefined && revertedAt <= asOfTxMs) continue;
    for (const event of entry.events) {
      let list = byEquipment.get(event.equipment);
      if (!list) byEquipment.set(event.equipment, (list = []));
      list.push({
        valid_ms: event.valid_ms,
        tx_time_ms: entry.tx_time_ms,
        state: event.state,
        seq: seq++,
      });
      if (event.valid_ms < minValidMs) minValidMs = event.valid_ms;
      if (event.valid_ms > maxValidMs) maxValidMs = event.valid_ms;
    }
  }

  for (const list of byEquipment.values()) {
    list.sort(
      (a, b) => a.valid_ms - b.valid_ms || a.tx_time_ms - b.tx_time_ms || a.seq - b.seq,
    );
  }

  // State of an equipment at valid instant tMs: the visible event with the
  // greatest valid_time <= tMs; ties on valid_time are broken by greatest
  // tx_time (a correction supersedes), then by arrival order.
  const stateAt = (equipment, tMs) => {
    const list = byEquipment.get(equipment);
    if (!list) return null;
    let best = null;
    for (const event of list) {
      if (event.valid_ms > tMs) break;
      best = event;
    }
    return best ? best.state : null;
  };

  const counts = new Map();
  if (minValidMs !== Infinity) {
    for (let day = dayStartMs(minValidMs); day <= dayStartMs(maxValidMs); day += DAY_MS) {
      let up = 0;
      let down = 0;
      const endOfDay = day + DAY_MS - 1;
      for (const equipment of byEquipment.keys()) {
        const state = stateAt(equipment, endOfDay);
        if (state === 'up') up += 1;
        else if (state === 'down') down += 1;
      }
      counts.set(dayString(day), { up, down });
    }
  }
  return { counts, stateAt };
}
