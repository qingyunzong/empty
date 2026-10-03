// 12 jobs in 4 parameter classes x 3 identical copies, 3 molds.
// Distinct class-level sequences: 12!/(3!^4) = 369600 (exhaustively checked).
export const fixture12 = {
  jobs: [
    { id: 0, due: 12, work: 3, energy: 4, mold: 'A' },
    { id: 1, due: 12, work: 3, energy: 4, mold: 'A' },
    { id: 2, due: 12, work: 3, energy: 4, mold: 'A' },
    { id: 3, due: 18, work: 2, energy: 5, mold: 'B' },
    { id: 4, due: 18, work: 2, energy: 5, mold: 'B' },
    { id: 5, due: 18, work: 2, energy: 5, mold: 'B' },
    { id: 6, due: 26, work: 4, energy: 3, mold: 'C' },
    { id: 7, due: 26, work: 4, energy: 3, mold: 'C' },
    { id: 8, due: 26, work: 4, energy: 3, mold: 'C' },
    { id: 9, due: 34, work: 2, energy: 2, mold: 'A' },
    { id: 10, due: 34, work: 2, energy: 2, mold: 'A' },
    { id: 11, due: 34, work: 2, energy: 2, mold: 'A' },
  ],
  setup: {
    A: { B: 2, C: 3 },
    B: { A: 2, C: 1 },
    C: { A: 4, B: 2 },
  },
  energyBudget: 100,
};
