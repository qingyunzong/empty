import { happensBefore } from './clock.js';

export const NEW = 'NEW';
export const CANCELED = 'CANCELED';
export const MATCHED = 'MATCHED';
export const CONFLICT = 'CONFLICT';

function causallyEarliest(events) {
  return events.reduce((a, b) => (happensBefore(b.clock, a.clock) ? b : a));
}

// Pure reducer: given the full event set of one order, derive its state.
// - cancel hb match  -> CANCELED (the match observed the cancel; it is void)
// - match hb cancel  -> MATCHED  (the cancel observed the match; it is void)
// - concurrent       -> CONFLICT (both events are kept, neither is dropped)
// A resolve event only takes effect when it causally observes BOTH
// conflicting events (its clock dominates both vector clocks).
export function reduceOrder(events) {
  const cancels = events.filter((e) => e.type === 'cancel');
  const matches = events.filter((e) => e.type === 'match');
  const resolves = events.filter((e) => e.type === 'resolve');

  let state = NEW;
  let conflict = null;
  const voidEvents = [];

  if (cancels.length && matches.length) {
    const cancel = causallyEarliest(cancels);
    const match = causallyEarliest(matches);
    if (happensBefore(cancel.clock, match.clock)) {
      state = CANCELED;
      voidEvents.push(match.eventId);
    } else if (happensBefore(match.clock, cancel.clock)) {
      state = MATCHED;
      voidEvents.push(cancel.eventId);
    } else {
      state = CONFLICT;
      conflict = { cancel, match };
    }
  } else if (cancels.length) {
    state = CANCELED;
  } else if (matches.length) {
    state = MATCHED;
  }

  let resolution = null;
  if (conflict) {
    for (const resolve of resolves) {
      const observesBoth =
        happensBefore(conflict.cancel.clock, resolve.clock) &&
        happensBefore(conflict.match.clock, resolve.clock);
      if (observesBoth && (!resolution || happensBefore(resolution.clock, resolve.clock))) {
        resolution = resolve;
      }
    }
    if (resolution) state = resolution.decision;
  }

  return { state, conflict, resolution, voidEvents };
}
