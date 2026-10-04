// Hand-enumerated reference: one station (cap 1, proc 2), input buffer cap 2,
// output buffer cap 4, arrivals at t = 0,1,2,3, fifo.
export const REFERENCE_CONFIG = {
  stations: [{ cap: 1, proc: 2 }],
  buffers: [{ cap: 2 }, { cap: 4 }],
  arrivals: { times: [0, 1, 2, 3] },
  policy: 'fifo',
};
