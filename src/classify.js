import { conflictError } from './errors.js';

// Pick the winning state for one atomic interval from its covering events.
// Highest priority wins; a tie between different types is a conflict because
// the line cannot be in two different states at the same priority level.
export function decideWinner(coveringEvents) {
  if (coveringEvents.length === 0) return null;
  let bestPriority = -Infinity;
  for (const e of coveringEvents) bestPriority = Math.max(bestPriority, e.priority);
  const winners = coveringEvents.filter((e) => e.priority === bestPriority);
  const types = new Set(winners.map((e) => e.type));
  if (types.size > 1) {
    throw conflictError('overlapping events of different types share the top priority', {
      priority: bestPriority,
      types: [...types],
      eventIds: winners.map((e) => e.id).sort(),
    });
  }
  return { type: winners[0].type, priority: bestPriority, eventIds: winners.map((e) => e.id).sort() };
}

// Map a winning state + merged-span duration to a planned/unplanned label.
// Threshold coupling: changeover and idle are planned only while their merged
// span stays within the configured threshold; fault is always unplanned.
export function classifyInterval(state, spanDurationMs, params) {
  switch (state) {
    case 'run':
      return { planned: true, downtime: false, rule: 'run-productive' };
    case 'maintenance':
      return { planned: true, downtime: true, rule: 'maintenance-planned' };
    case 'changeover':
      return spanDurationMs <= params.changeoverPlannedThresholdMs
        ? { planned: true, downtime: true, rule: 'changeover-within-threshold' }
        : { planned: false, downtime: true, rule: 'changeover-exceeds-threshold' };
    case 'idle':
      return spanDurationMs <= params.microStopThresholdMs
        ? { planned: true, downtime: true, rule: 'idle-micro-stop' }
        : { planned: false, downtime: true, rule: 'idle-exceeds-micro-stop' };
    case 'fault':
      return { planned: false, downtime: true, rule: 'fault-unplanned' };
    default:
      return { planned: null, downtime: false, rule: 'uncovered-gap' };
  }
}

export function thresholdFor(state, params) {
  if (state === 'changeover') return params.changeoverPlannedThresholdMs;
  if (state === 'idle') return params.microStopThresholdMs;
  return null;
}
