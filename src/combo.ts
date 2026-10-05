// Lexicographic k-combinations over [0, n). Iterating from firstCombination(k)
// via nextCombination visits every k-subset exactly once in lexicographic
// order of the index tuples; because constraint names are sorted before use,
// this is also lexicographic order over the sorted name tuples. A combination
// can be serialized (it is just a number[]) and resumed later, which is what
// the pausable frontier persists.

export function firstCombination(k: number): number[] {
  return Array.from({ length: k }, (_, i) => i);
}

export function nextCombination(combo: number[], n: number): number[] | null {
  const k = combo.length;
  const next = combo.slice();
  let i = k - 1;
  while (i >= 0 && next[i] === n - k + i) i--;
  if (i < 0) return null;
  next[i]++;
  for (let j = i + 1; j < k; j++) next[j] = next[j - 1] + 1;
  return next;
}

export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}
