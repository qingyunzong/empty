export function spaceSize(domains: string[][]): bigint {
  let total = 1n;
  for (const domain of domains) total *= BigInt(domain.length + 1);
  return total;
}

export function completionCount(domains: string[][]): number {
  let total = 1;
  for (const domain of domains) {
    total *= domain.length;
    if (total > Number.MAX_SAFE_INTEGER / 4) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function* genValues(domains: string[][], chosen: number[], pos: number, assignment: number[]): Generator<number[]> {
  if (pos === chosen.length) {
    yield assignment.slice();
    return;
  }
  const attr = chosen[pos]!;
  for (let value = 0; value < domains[attr]!.length; value++) {
    assignment[attr] = value;
    yield* genValues(domains, chosen, pos + 1, assignment);
  }
  assignment[attr] = -1;
}

function* genCombos(
  domains: string[][],
  size: number,
  start: number,
  chosen: number[],
  assignment: number[]
): Generator<number[]> {
  if (chosen.length === size) {
    yield* genValues(domains, chosen, 0, assignment);
    return;
  }
  const remaining = size - chosen.length;
  for (let attr = start; attr <= domains.length - remaining; attr++) {
    chosen.push(attr);
    yield* genCombos(domains, size, attr + 1, chosen, assignment);
    chosen.pop();
  }
}

export function* enumerateRecursive(domains: string[][]): Generator<number[]> {
  for (let size = 0; size <= domains.length; size++) {
    yield* genCombos(domains, size, 0, [], new Array(domains.length).fill(-1));
  }
}

function nextCombination(count: number, size: number, combo: number[]): number[] | null {
  let pivot = size - 1;
  while (pivot >= 0 && combo[pivot] === count - size + pivot) pivot--;
  if (pivot < 0) return null;
  const next = combo.slice();
  next[pivot]!++;
  for (let i = pivot + 1; i < size; i++) next[i] = next[i - 1]! + 1;
  return next;
}

export function* enumerateOdometer(domains: string[][]): Generator<number[]> {
  const count = domains.length;
  for (let size = 0; size <= count; size++) {
    let combo: number[] | null = Array.from({ length: size }, (_, i) => i);
    while (combo !== null) {
      const tuple = new Array(size).fill(0);
      for (;;) {
        const assignment = new Array(count).fill(-1);
        for (let i = 0; i < size; i++) assignment[combo[i]!] = tuple[i]!;
        yield assignment;
        let pos = size - 1;
        while (pos >= 0) {
          tuple[pos]!++;
          if (tuple[pos]! < domains[combo[pos]!]!.length) break;
          tuple[pos] = 0;
          pos--;
        }
        if (pos < 0) break;
      }
      combo = nextCombination(count, size, combo);
    }
  }
}
