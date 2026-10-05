import {
  acquireLock,
  createWorld,
  pickItem,
  placeItem,
  releaseLock,
  verifyWorld,
} from './model.js';
import type { WorldConfig, WorldState } from './model.js';
import type { SimEvent } from './simulator.js';

export interface ReplayViolation {
  seq: number;
  issues: string[];
}

export interface ReplayResult {
  state: WorldState;
  snapshots: Map<string, WorldState>;
  violations: ReplayViolation[];
}

/**
 * Re-apply a recorded event log onto a fresh world built from `config`.
 * Invariants (item uniqueness, resource conservation) are re-checked after
 * every single event, and a snapshot is reconstructed at each 'snapshot'
 * event so it can be compared with the one captured during the live run.
 */
export function replayEvents(config: WorldConfig, events: SimEvent[]): ReplayResult {
  const state = createWorld(config);
  const snapshots = new Map<string, WorldState>();
  const violations: ReplayViolation[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'acquired':
        acquireLock(state, event.arm, event.segment);
        break;
      case 'released':
        releaseLock(state, event.arm, event.segment);
        break;
      case 'picked':
        pickItem(state, event.arm, event.segment, event.item);
        break;
      case 'placed':
        placeItem(state, event.arm, event.segment, event.item);
        break;
      case 'snapshot':
        snapshots.set(event.label, structuredClone(state));
        break;
      default:
        break; // action_*, blocked, unblocked, deadlock: no state mutation
    }
    const issues = verifyWorld(state);
    if (issues.length > 0) violations.push({ seq: event.seq, issues });
  }
  return { state, snapshots, violations };
}

export function statesEqual(a: WorldState, b: WorldState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
