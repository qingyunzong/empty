'use strict';

// Exact solve of square system A x = b over the rationals.
// A: array of n rows, each an array of n Rat. b: array of n Rat.
// Returns array of n Rat, or null if A is singular.
function solve(A, b) {
  const n = A.length;
  if (n === 0) return [];
  const M = A.map((row, i) => row.slice().concat([b[i]]));
  let rank = 0;
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = rank; r < n; r++) {
      if (!M[r][col].isZero()) { piv = r; break; }
    }
    if (piv < 0) return null;
    const tmp = M[rank]; M[rank] = M[piv]; M[piv] = tmp;
    const pivInv = M[rank][col].inv();
    for (let r = 0; r < n; r++) {
      if (r === rank || M[r][col].isZero()) continue;
      const f = M[r][col].mul(pivInv);
      for (let c = col; c <= n; c++) {
        M[r][c] = M[r][c].sub(f.mul(M[rank][c]));
      }
    }
    rank++;
  }
  return M.map((row, i) => row[n].mul(M[i][i].inv()));
}

module.exports = { solve };
