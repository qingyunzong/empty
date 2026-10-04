import { SimError, ERR_CYCLE } from './errors.js';

// Shared, side-effect-explicit state machine helpers used by both the
// deterministic simulator and the certificate state-space explorer.
//
// State layout:
//   {
//     time,
//     nextArrivalIdx,
//     buffers:        [ [item, ...], ... ]          // buffers[i] feeds stations[i]
//     stations:       [ { slots: [{item, end}] }, ... ]
//     pendingCustom:  [ {time, apply}, ... ]
//   }
// Items are immutable: { id, time, priority }.

export function createInitialState(norm) {
  return {
    time: 0,
    nextArrivalIdx: 0,
    buffers: norm.buffers.map(() => []),
    stations: norm.stations.map(() => ({ slots: [] })),
    everBusy: norm.stations.map(() => false),
    pendingCustom: norm.customEvents.map((e) => ({ time: e.time, apply: e.apply })),
  };
}

export function cloneState(state) {
  return {
    time: state.time,
    nextArrivalIdx: state.nextArrivalIdx,
    buffers: state.buffers.map((b) => b.slice()),
    stations: state.stations.map((s) => ({ slots: s.slots.slice() })),
    everBusy: state.everBusy.slice(),
    pendingCustom: state.pendingCustom.slice(),
  };
}

export function stateKey(state) {
  return JSON.stringify([
    state.nextArrivalIdx,
    state.buffers.map((b) => b.map((it) => it.id)),
    state.stations.map((s) => s.slots.map((sl) => [sl.item.id, sl.end])),
    state.everBusy,
    state.pendingCustom.length,
  ]);
}

export function nextEventTime(state, norm) {
  let t = null;
  const consider = (x) => {
    if (t === null || x < t) t = x;
  };
  if (state.nextArrivalIdx < norm.arrivals.length) consider(norm.arrivals[state.nextArrivalIdx].time);
  for (const st of state.stations) for (const sl of st.slots) consider(sl.end);
  for (const c of state.pendingCustom) consider(c.time);
  return t;
}

// Completes every slot whose end time is due at state.time and delivers items
// to the downstream buffer. Returns { violation, count }.
export function applyCompletions(state, norm, emit) {
  const t = state.time;
  let violation = null;
  let count = 0;
  for (let i = 0; i < state.stations.length; i += 1) {
    const st = state.stations[i];
    if (!st.slots.some((sl) => sl.end <= t)) continue;
    const due = st.slots.filter((sl) => sl.end <= t);
    st.slots = st.slots.filter((sl) => sl.end > t);
    for (const slot of due) {
      count += 1;
      const target = i + 1;
      emit?.({ type: 'complete', item: slot.item.id, station: i, buffer: target });
      if (state.buffers[target].length < norm.buffers[target].cap) {
        state.buffers[target].push(slot.item);
      } else if (!violation) {
        violation = { type: 'bufferOverflow', buffer: target, item: slot.item.id, time: t };
      }
    }
  }
  return { violation, count };
}

// Enqueues every arrival due at state.time into buffer 0, in stable id order.
export function applyArrivals(state, norm, emit) {
  const t = state.time;
  let violation = null;
  while (state.nextArrivalIdx < norm.arrivals.length && norm.arrivals[state.nextArrivalIdx].time <= t) {
    const item = norm.arrivals[state.nextArrivalIdx];
    state.nextArrivalIdx += 1;
    emit?.({ type: 'arrival', item: item.id, buffer: 0 });
    if (state.buffers[0].length < norm.buffers[0].cap) {
      state.buffers[0].push(item);
    } else if (!violation) {
      violation = { type: 'bufferOverflow', buffer: 0, item: item.id, time: t };
    }
  }
  return violation;
}

// fifo: oldest item. priority: smallest (priority, id) pair, i.e. stable.
export function pickFromBuffer(items, policy) {
  if (policy === 'fifo') return items[0];
  let best = items[0];
  for (const it of items) {
    if (it.priority < best.priority || (it.priority === best.priority && it.id < best.id)) best = it;
  }
  return best;
}

// One work-conserving pass: every station with a free slot and a non-empty
// input buffer starts an item. Records policy-sensitive decisions (buffer
// length >= 2) when `decisions` is provided.
export function pullPass(state, norm, policy, emit, decisions) {
  let progress = false;
  for (let i = 0; i < state.stations.length; i += 1) {
    const st = state.stations[i];
    while (st.slots.length < norm.stations[i].cap && state.buffers[i].length > 0) {
      const item = pickFromBuffer(state.buffers[i], policy);
      if (decisions && state.buffers[i].length >= 2) {
        decisions.push({
          station: i,
          items: state.buffers[i].map((it) => ({ id: it.id, priority: it.priority })),
          chosen: item.id,
        });
      }
      const idx = state.buffers[i].findIndex((it) => it.id === item.id);
      state.buffers[i].splice(idx, 1);
      st.slots.push({ item, end: state.time + norm.stations[i].proc });
      state.everBusy[i] = true;
      emit?.({ type: 'start', item: item.id, station: i });
      progress = true;
    }
  }
  return progress;
}

// Extension hook: user-supplied events. An event may schedule further events
// via ctx.schedule(time, apply). Scheduling in the past, or failing to
// quiesce within cycleLimit iterations at one timestamp, is an event cycle.
export function applyCustomEvents(state, norm) {
  let iterations = 0;
  for (;;) {
    const idx = state.pendingCustom.findIndex((c) => c.time <= state.time);
    if (idx === -1) return;
    iterations += 1;
    if (iterations > norm.cycleLimit) {
      throw new SimError(ERR_CYCLE, `custom events did not quiesce at time ${state.time} within ${norm.cycleLimit} iterations (event cycle)`);
    }
    const [ev] = state.pendingCustom.splice(idx, 1);
    const ctx = {
      time: state.time,
      schedule: (t, apply) => {
        if (!(typeof t === 'number' && Number.isFinite(t))) {
          throw new SimError(ERR_CYCLE, `invalid scheduled event time ${t}`);
        }
        if (t < state.time) {
          throw new SimError(ERR_CYCLE, `event scheduled in the past (t=${t} < current ${state.time})`);
        }
        state.pendingCustom.push({ time: t, apply });
      },
    };
    ev.apply(state, ctx);
  }
}

// A station is starved when it has a free slot, its input buffer is empty,
// and work that must still pass through it exists upstream (pending arrivals,
// items in earlier buffers, or busy earlier stations). Stations that have
// never been busy are still ramping up and are not reported as starved.
export function starvedStations(state, norm) {
  const result = [];
  const pending = state.nextArrivalIdx < norm.arrivals.length;
  for (let i = 0; i < state.stations.length; i += 1) {
    if (!state.everBusy[i]) continue;
    if (state.stations[i].slots.length >= norm.stations[i].cap) continue;
    if (state.buffers[i].length > 0) continue;
    let upstream = pending;
    for (let j = 0; j < i && !upstream; j += 1) {
      if (state.buffers[j].length > 0 || state.stations[j].slots.length > 0) upstream = true;
    }
    if (upstream) result.push(i);
  }
  return result;
}
