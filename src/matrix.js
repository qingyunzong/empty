// Exact dense linear algebra over BigInt for tiny systems (n <= 3).
// Determinants use the Leibniz formula (<= 6 terms), solving uses Cramer's rule.

import { Rat } from './rational.js';

function* permutations(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  yield idx.slice();
  const c = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [idx[i], idx[j]] = [idx[j], idx[i]];
      yield idx.slice();
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function parity(perm) {
  let inversions = 0;
  for (let i = 0; i < perm.length; i++) {
    for (let j = i + 1; j < perm.length; j++) {
      if (perm[i] > perm[j]) inversions += 1;
    }
  }
  return inversions % 2 === 0 ? 1n : -1n;
}

export function det(matrix) {
  const n = matrix.length;
  let total = 0n;
  for (const perm of permutations(n)) {
    let term = parity(perm);
    for (let i = 0; i < n; i++) term *= matrix[i][perm[i]];
    total += term;
  }
  return total;
}

// Solves matrix * x = rhs exactly. Returns an array of Rat, or null if singular.
export function solve(matrix, rhs) {
  const d = det(matrix);
  if (d === 0n) return null;
  const n = matrix.length;
  const x = [];
  for (let col = 0; col < n; col++) {
    const replaced = matrix.map((row, r) => row.map((v, c) => (c === col ? rhs[r] : v)));
    x.push(new Rat(det(replaced), d));
  }
  return x;
}
