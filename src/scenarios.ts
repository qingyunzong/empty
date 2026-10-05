import type { ActionDef, WorldConfig } from './model.js';

/** Two arms swap two items across one shared (mutex) track segment S. */
export function crossingWorld(): WorldConfig {
  return {
    segments: [
      { id: 'A', capacity: 2, lockCapacity: 2 },
      { id: 'S', capacity: 1, lockCapacity: 1 }, // shared interval: mutual exclusion
      { id: 'B', capacity: 2, lockCapacity: 2 },
    ],
    items: [
      { id: 'i1', at: 'A' },
      { id: 'i2', at: 'B' },
    ],
    arms: ['r1', 'r2'],
  };
}

export function crossingActions(): ActionDef[] {
  return [
    {
      id: 'r1-carry-i1',
      arm: 'r1',
      steps: [
        { kind: 'acquire', segment: 'A' },
        { kind: 'pick', item: 'i1', segment: 'A' },
        { kind: 'acquire', segment: 'S' },
        { kind: 'release', segment: 'A' },
        { kind: 'acquire', segment: 'B' },
        { kind: 'place', item: 'i1', segment: 'B' },
        { kind: 'release', segment: 'B' },
        { kind: 'release', segment: 'S' },
      ],
    },
    {
      id: 'r2-carry-i2',
      arm: 'r2',
      steps: [
        { kind: 'acquire', segment: 'B' },
        { kind: 'pick', item: 'i2', segment: 'B' },
        { kind: 'acquire', segment: 'S' },
        { kind: 'release', segment: 'B' },
        { kind: 'acquire', segment: 'A' },
        { kind: 'place', item: 'i2', segment: 'A' },
        { kind: 'release', segment: 'A' },
        { kind: 'release', segment: 'S' },
      ],
    },
  ];
}

/** Two arms lock two shared segments in opposite order: circular wait. */
export function deadlockWorld(): WorldConfig {
  return {
    segments: [
      { id: 'S1', capacity: 1, lockCapacity: 1 },
      { id: 'S2', capacity: 1, lockCapacity: 1 },
    ],
    items: [],
    arms: ['r1', 'r2'],
  };
}

export function deadlockActions(): ActionDef[] {
  return [
    {
      id: 'r1-forward',
      arm: 'r1',
      steps: [
        { kind: 'acquire', segment: 'S1' },
        { kind: 'acquire', segment: 'S2' },
        { kind: 'release', segment: 'S2' },
        { kind: 'release', segment: 'S1' },
      ],
    },
    {
      id: 'r2-backward',
      arm: 'r2',
      steps: [
        { kind: 'acquire', segment: 'S2' },
        { kind: 'acquire', segment: 'S1' },
        { kind: 'release', segment: 'S1' },
        { kind: 'release', segment: 'S2' },
      ],
    },
  ];
}
