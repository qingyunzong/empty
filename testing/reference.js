// Reference algorithm: enumerate the device state for every single
// millisecond of the observation window, then collapse into segments.
// Deliberately naive; used to cross-check the real merging library.
export function referenceIntervals(events, from, to) {
  const sorted = [...events].sort((a, b) => a.utcMs - b.utcMs || a.version - b.version);
  const segments = [];
  let curState = null;
  let curStart = null;
  for (let t = from; t < to; t++) {
    let state = null;
    for (const e of sorted) {
      if (e.utcMs <= t) state = e.state;
      else break;
    }
    if (state !== curState) {
      if (curState !== null) segments.push({ state: curState, start: curStart, end: t });
      curState = state;
      curStart = t;
    }
  }
  if (curState !== null) segments.push({ state: curState, start: curStart, end: to });
  return segments;
}

// Same naive enumeration, but additionally split at period boundaries and
// merge adjacent periods inside a common silence window with equal state.
export function referenceWithPeriods(events, from, to, windows, silence) {
  const sorted = [...events].sort((a, b) => a.utcMs - b.utcMs || a.version - b.version);
  const stateAt = (t) => {
    let state = null;
    for (const e of sorted) {
      if (e.utcMs <= t) state = e.state;
      else break;
    }
    return state;
  };
  const windowIndexAt = (t) => {
    for (let k = 0; k < windows.length; k++) {
      if (windows[k].start <= t && t < windows[k].end) return k;
    }
    return -1;
  };
  // Adjacent windows covered by one common silence window share a merge key.
  const mergeKey = windows.map((w, k) => {
    for (const sw of silence) {
      if (sw.start <= w.start && sw.end >= w.end) {
        for (let j = 0; j <= k; j++) {
          if (sw.start <= windows[j].start && sw.end >= windows[j].end) return j;
        }
      }
    }
    return k;
  });
  const segments = [];
  let curState = null;
  let curKey = null;
  let curStart = null;
  for (let t = from; t < to; t++) {
    const state = stateAt(t);
    const wi = windowIndexAt(t);
    const key = state === null ? null : `${state}@${wi === -1 ? 'x' : mergeKey[wi]}`;
    if (key !== curKey) {
      if (curState !== null) segments.push({ state: curState, start: curStart, end: t });
      curState = state;
      curKey = key;
      curStart = t;
    }
  }
  if (curState !== null) segments.push({ state: curState, start: curStart, end: to });
  return segments;
}
