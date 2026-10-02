const DEFAULT_MAX_EXACT_CANDIDATES = 24;

function sortSolution(solution) {
  return [...solution].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function solutionKey(solution) {
  return sortSolution(solution).join('');
}

function enumerateMinimumCovers(candidates, universeSize) {
  const n = candidates.length;
  const fullMask = universeSize === 64 ? -1n : (1n << BigInt(universeSize)) - 1n;
  const covers = candidates.map((candidate) => candidate.mask);
  const lots = candidates.map((candidate) => candidate.lot);

  const suffixUnion = new Array(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i -= 1) suffixUnion[i] = suffixUnion[i + 1] | covers[i];

  let bestSize = Infinity;
  const solutions = [];
  const seen = new Set();

  function dfs(index, chosenMask, chosenLots) {
    if (chosenLots.length > bestSize) return;
    if (chosenMask === fullMask) {
      if (chosenLots.length < bestSize) {
        bestSize = chosenLots.length;
        solutions.length = 0;
        seen.clear();
      }
      const key = solutionKey(chosenLots);
      if (!seen.has(key)) {
        seen.add(key);
        solutions.push(sortSolution(chosenLots));
      }
      return;
    }
    if (index >= n) return;
    if (chosenLots.length + 1 > bestSize) return;
    if ((chosenMask | suffixUnion[index]) !== fullMask) return;

    chosenLots.push(lots[index]);
    dfs(index + 1, chosenMask | covers[index], chosenLots);
    chosenLots.pop();
    dfs(index + 1, chosenMask, chosenLots);
  }

  dfs(0, 0n, []);
  solutions.sort((a, b) => {
    const keyA = a.join('');
    const keyB = b.join('');
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return { size: solutions.length === 0 ? 0 : bestSize, solutions };
}

function greedyCover(candidates, universeSize) {
  const fullMask = universeSize === 64 ? -1n : (1n << BigInt(universeSize)) - 1n;
  let covered = 0n;
  const chosen = [];
  const remaining = candidates.map((candidate) => ({ ...candidate }));
  while (covered !== fullMask && remaining.length > 0) {
    let bestIndex = -1;
    let bestGain = 0n;
    for (let i = 0; i < remaining.length; i += 1) {
      const gain = remaining[i].mask & ~covered;
      if (gain !== 0n && (bestIndex === -1 || countBits(gain) > countBits(bestGain))) {
        bestIndex = i;
        bestGain = gain;
      }
    }
    if (bestIndex === -1) break;
    covered |= remaining[bestIndex].mask;
    chosen.push(remaining[bestIndex].lot);
    remaining.splice(bestIndex, 1);
  }
  return { size: chosen.length, solutions: [sortSolution(chosen)] };
}

function countBits(mask) {
  let count = 0;
  let value = mask;
  while (value !== 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

export function minimumSetCovers(windows, options = {}) {
  const maxExact = options.maxExactCandidates ?? DEFAULT_MAX_EXACT_CANDIDATES;
  const universe = windows.filter((window) => window.lots.length > 0);
  if (universe.length === 0) return { size: 0, solutions: [[]], exact: true };
  if (universe.length > 64) {
    throw new Error(`set cover universe too large (${universe.length} windows, max 64)`);
  }

  const lotSet = new Set();
  for (const window of universe) for (const lot of window.lots) lotSet.add(lot);
  const candidates = [...lotSet].sort().map((lot) => {
    let mask = 0n;
    universe.forEach((window, index) => {
      if (window.lots.includes(lot)) mask |= 1n << BigInt(index);
    });
    return { lot, mask };
  });

  const exact = candidates.length <= maxExact;
  const result = exact
    ? enumerateMinimumCovers(candidates, universe.length)
    : greedyCover(candidates, universe.length);
  return { ...result, exact };
}
