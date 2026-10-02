// Independent naive reference implementation, used to cross-check the sweep-line
// pipeline (acceptance: <=14 events must match reference enumeration of all legal
// intervals). Deliberately written as a brute-force O(boundaries x events) scan with
// its own merge/absorb/classify logic; shares only the PRIORITY table.

const PRIORITY = { fault: 50, maintenance: 40, changeover: 30, idle: 20, run: 10, uncovered: 0 };

function winnerAt(events, s, e) {
  let best = null;
  for (const ev of events) {
    if (ev.start < e && ev.end > s) {
      if (
        !best ||
        PRIORITY[ev.type] > PRIORITY[best.type] ||
        (PRIORITY[ev.type] === PRIORITY[best.type] && String(ev.id) < String(best.id))
      ) {
        best = ev;
      }
    }
  }
  return best;
}

export function referenceTimeline(events, params) {
  const pts = [...new Set(events.flatMap((e) => [e.start, e.end]))].sort((a, b) => a - b);
  let segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    const best = winnerAt(events, s, e);
    segs.push({ start: s, end: e, state: best ? best.type : 'uncovered', sources: best ? [best.id] : [] });
  }

  // merge adjacent same-state segments
  segs = segs.reduce((acc, seg) => {
    const last = acc[acc.length - 1];
    if (last && last.state === seg.state && last.end === seg.start) {
      last.end = seg.end;
      for (const id of seg.sources) if (!last.sources.includes(id)) last.sources.push(id);
    } else {
      acc.push({ ...seg, sources: [...seg.sources] });
    }
    return acc;
  }, []);

  // absorb short segments: loop until none below threshold
  for (;;) {
    let idx = -1;
    for (let i = 0; i < segs.length; i++) {
      const d = segs[i].end - segs[i].start;
      if (d < params.minSegmentMs && (idx === -1 || d < segs[idx].end - segs[idx].start)) idx = i;
    }
    if (idx === -1 || segs.length < 2) break;
    const seg = segs[idx];
    const left = idx > 0 ? segs[idx - 1] : null;
    const right = idx < segs.length - 1 ? segs[idx + 1] : null;
    const pl = left ? PRIORITY[left.state] : -1;
    const pr = right ? PRIORITY[right.state] : -1;
    if (pl >= pr) {
      left.end = seg.end;
      for (const id of seg.sources) if (!left.sources.includes(id)) left.sources.push(id);
    } else {
      right.start = seg.start;
      for (const id of seg.sources) if (!right.sources.includes(id)) right.sources.push(id);
    }
    segs.splice(idx, 1);
  }

  // merge again after absorption
  segs = segs.reduce((acc, seg) => {
    const last = acc[acc.length - 1];
    if (last && last.state === seg.state && last.end === seg.start) {
      last.end = seg.end;
      for (const id of seg.sources) if (!last.sources.includes(id)) last.sources.push(id);
    } else {
      acc.push({ ...seg, sources: [...seg.sources] });
    }
    return acc;
  }, []);

  // classify
  return segs.map((seg) => {
    const dur = seg.end - seg.start;
    let planned;
    let reason;
    switch (seg.state) {
      case 'run':
        planned = true; reason = 'run: productive time'; break;
      case 'maintenance':
        planned = true; reason = 'maintenance: planned by type'; break;
      case 'changeover': {
        const ok = dur <= params.changeoverPlannedBudgetMs;
        planned = ok;
        reason = `changeover ${dur}ms ${ok ? '<=' : '>'} budget ${params.changeoverPlannedBudgetMs}ms -> ${ok ? 'planned' : 'unplanned'}`;
        break;
      }
      case 'idle':
        planned = false; reason = 'idle: unplanned by rule'; break;
      case 'fault':
        planned = false; reason = 'fault: unplanned by rule'; break;
      default:
        planned = false; reason = 'uncovered: no event covers this interval';
    }
    return { ...seg, planned, reason };
  });
}
