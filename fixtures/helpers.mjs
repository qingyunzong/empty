export const MAP = {
  bounds: { width: 20, height: 20 },
  zones: [
    {
      id: 'Z-OPEN',
      kind: 'normal',
      aisles: [{ id: 'A-OPEN-1', shelves: [{ id: 'S-OPEN-1', x: 1, y: 1 }] }],
    },
    {
      id: 'Z-RESTRICTED',
      kind: 'restricted',
      aisles: [{ id: 'A-R-1', shelves: [{ id: 'S-R-1', x: 5, y: 5 }] }],
    },
    {
      id: 'Z-COLD',
      kind: 'coldchain',
      aisles: [{ id: 'A-C-1', shelves: [{ id: 'S-C-1', x: 8, y: 8 }] }],
    },
    {
      id: 'Z-CHARGE',
      kind: 'charging',
      aisles: [{ id: 'A-CH-1', shelves: [{ id: 'S-CH-1', x: 9, y: 9 }] }],
    },
  ],
};

export function grant(id, extra = {}) {
  return {
    id,
    kind: 'grant',
    subject: 'agv-1',
    zone: 'Z-COLD',
    from: 0,
    to: 100,
    clock: { node: 'ops', counter: 1 },
    parents: [],
    ...extra,
  };
}

export function task(id, extra = {}) {
  return {
    id,
    subject: 'agv-1',
    type: 'normal',
    priority: 5,
    target: { zone: 'Z-COLD' },
    time: 10,
    completeTime: 20,
    clock: { node: 'agv-1', counter: 2 },
    parents: [],
    ...extra,
  };
}
