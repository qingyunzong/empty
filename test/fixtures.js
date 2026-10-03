// Shared fixtures for the acceptance scenarios.

// Scenario 1: two work orders sharing multi-level components.
//   P1 -(2)-> A -(3)-> C -(2)-> D
//   P1 -(1)-> B -(4)-> C
//   P2 -(1)-> A
// WO1: P1 x 5, WO2: P2 x 2
export const scenario1Events = [
  { op: 'insert', entity: 'workorder', key: { id: 'WO1' }, value: { product: 'P1', qty: 5 } },
  { op: 'insert', entity: 'workorder', key: { id: 'WO2' }, value: { product: 'P2', qty: 2 } },
  { op: 'insert', entity: 'bom', key: { parent: 'P1', component: 'A' }, value: { usage: 2 } },
  { op: 'insert', entity: 'bom', key: { parent: 'P1', component: 'B' }, value: { usage: 1 } },
  { op: 'insert', entity: 'bom', key: { parent: 'A', component: 'C' }, value: { usage: 3 } },
  { op: 'insert', entity: 'bom', key: { parent: 'B', component: 'C' }, value: { usage: 4 } },
  { op: 'insert', entity: 'bom', key: { parent: 'C', component: 'D' }, value: { usage: 2 } },
  { op: 'insert', entity: 'bom', key: { parent: 'P2', component: 'A' }, value: { usage: 1 } },
  { op: 'insert', entity: 'inventory', key: { component: 'A' }, value: { qty: 4 } },
  { op: 'insert', entity: 'inventory', key: { component: 'B' }, value: { qty: 10 } },
  { op: 'insert', entity: 'inventory', key: { component: 'C' }, value: { qty: null } },
  { op: 'insert', entity: 'inventory', key: { component: 'D' }, value: { qty: 100 } },
];

export const scenario1Gross = { A: 12, B: 5, C: 56, D: 112 };
export const scenario1Net = { A: 8, B: -5, C: null, D: 12 };

// Reference path enumeration values: order, path, per-component quantities.
export const scenario1Paths = [
  { order: 'WO1', path: ['P1', 'A', 'C', 'D'], quantities: { A: 10, C: 30, D: 60 } },
  { order: 'WO1', path: ['P1', 'B', 'C', 'D'], quantities: { B: 5, C: 20, D: 40 } },
  { order: 'WO2', path: ['P2', 'A', 'C', 'D'], quantities: { A: 2, C: 6, D: 12 } },
];

// Scenario 2: inventory corrected from null (unknown) to 0.
export const scenario2Setup = [
  { op: 'insert', entity: 'workorder', key: { id: 'WO9' }, value: { product: 'P9', qty: 1 } },
  { op: 'insert', entity: 'bom', key: { parent: 'P9', component: 'C9' }, value: { usage: 5 } },
  { op: 'insert', entity: 'inventory', key: { component: 'C9' }, value: { qty: null } },
];
export const scenario2Correct = [
  { op: 'correct', entity: 'inventory', key: { component: 'C9' }, value: { qty: 0 } },
];
export const scenario2BadCorrect = [
  { op: 'correct', entity: 'inventory', key: { component: 'NOPE' }, value: { qty: 1 } },
];

// Scenario 3: crash points.
export const scenario3Setup = [
  { op: 'insert', entity: 'workorder', key: { id: 'WO1' }, value: { product: 'P1', qty: 2 } },
  { op: 'insert', entity: 'bom', key: { parent: 'P1', component: 'C1' }, value: { usage: 3 } },
  { op: 'insert', entity: 'inventory', key: { component: 'C1' }, value: { qty: 1 } },
];
export const scenario3Update = [
  { op: 'correct', entity: 'inventory', key: { component: 'C1' }, value: { qty: 10 } },
];
