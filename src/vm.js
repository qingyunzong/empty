// Incremental VM: evaluates rule bytecode over per-device event windows and
// maintains the current alert set.
//
// A series is a step function of time: { initial, points: [[ms, value], ...] }
// with points sorted by time (stable). Value at t is the last point <= t,
// or `initial` when there is none.

const CMP_FNS = {
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
  ge: (a, b) => a >= b,
  le: (a, b) => a <= b,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
};

function constSeries(value) {
  return { initial: value, points: [] };
}

function fieldSeries(events, field) {
  const points = [];
  for (const ev of events) {
    if (ev.type === field) points.push([ev.time, ev.value]);
  }
  return { initial: undefined, points };
}

function valueAt(series, t) {
  let v = series.initial;
  for (const [pt, pv] of series.points) {
    if (pt > t) break;
    v = pv;
  }
  return v;
}

function combine(a, b, f) {
  const out = { initial: f(a.initial, b.initial), points: [] };
  let av = a.initial;
  let bv = b.initial;
  let cur = out.initial;
  let i = 0;
  let j = 0;
  while (i < a.points.length || j < b.points.length) {
    let t;
    if (j >= b.points.length || (i < a.points.length && a.points[i][0] < b.points[j][0])) {
      t = a.points[i][0];
    } else {
      t = b.points[j][0];
    }
    while (i < a.points.length && a.points[i][0] === t) av = a.points[i++][1];
    while (j < b.points.length && b.points[j][0] === t) bv = b.points[j++][1];
    const r = f(av, bv);
    if (r !== cur) {
      out.points.push([t, r]);
      cur = r;
    }
  }
  return out;
}

function mapSeries(a, f) {
  return { initial: f(a.initial), points: a.points.map(([t, v]) => [t, f(v)]) };
}

// True only after the input has held true continuously for `ms`,
// measured from `start` (the window start) onward.
function hold(series, ms, start) {
  const out = { initial: false, points: [] };
  let cur = valueAt(series, start);
  let since = cur ? start : null;
  for (const [t, v] of series.points) {
    if (t <= start) continue;
    if (v && !cur) {
      since = t;
      cur = true;
    } else if (!v && cur) {
      if (t - since >= ms) {
        out.points.push([since + ms, true]);
        out.points.push([t, false]);
      }
      cur = false;
      since = null;
    }
  }
  if (cur && since !== null) {
    out.points.push([since + ms, true]);
  }
  return out;
}

// Extract alert intervals from a boolean series evaluated from `start`.
// Returns [{ at, end }] where end === null means the alert is still active.
export function extractAlerts(series, start) {
  const alerts = [];
  let cur = valueAt(series, start);
  let open = cur ? { at: start, end: null } : null;
  for (const [t, v] of series.points) {
    if (t <= start || v === cur) continue;
    if (v) {
      open = { at: t, end: null };
    } else if (open) {
      open.end = t;
      alerts.push(open);
      open = null;
    }
    cur = v;
  }
  if (open) alerts.push(open);
  return alerts;
}

// Run one compiled rule against one device's event window.
// Returns alert intervals [{ at, end }].
export function evaluateRule(program, events) {
  if (events.length === 0) return [];
  const start = events[0].time;
  const fields = new Map();
  const stack = [];
  for (const ins of program) {
    switch (ins.op) {
      case 'CONST':
        stack.push(constSeries(ins.value));
        break;
      case 'LOAD': {
        if (!fields.has(ins.field)) fields.set(ins.field, fieldSeries(events, ins.field));
        stack.push(fields.get(ins.field));
        break;
      }
      case 'CMP': {
        const b = stack.pop();
        const a = stack.pop();
        const f = CMP_FNS[ins.cmp];
        stack.push(combine(a, b, (x, y) => (x === undefined || y === undefined ? false : f(x, y))));
        break;
      }
      case 'AND': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(combine(a, b, (x, y) => Boolean(x) && Boolean(y)));
        break;
      }
      case 'OR': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push(combine(a, b, (x, y) => Boolean(x) || Boolean(y)));
        break;
      }
      case 'NOT':
        stack.push(mapSeries(stack.pop(), (x) => !x));
        break;
      case 'HOLD':
        stack.push(hold(stack.pop(), ins.ms, start));
        break;
      default:
        throw new Error(`unknown opcode '${ins.op}'`);
    }
  }
  if (stack.length !== 1) throw new Error('bytecode stack imbalance');
  return extractAlerts(stack[0], start);
}
