// Independent exhaustive enumerator and direct assignment checker. Used by
// the test-suite to cross-check the propagation+backtracking solver: it
// enumerates every legal parent subset and every integer quantity split
// without any propagation, then validates constraints directly.

function* tuples(caps, need) {
  const k = caps.length;
  const current = new Array(k).fill(0);
  function* rec(i, rem) {
    if (i === k) {
      if (rem === 0) yield [...current];
      return;
    }
    for (let v = 0; v <= Math.min(caps[i], rem); v += 1) {
      current[i] = v;
      yield* rec(i + 1, rem - v);
    }
  }
  yield* rec(0, need);
}

export function hasLineOverlap(batches) {
  const byLine = new Map();
  for (const b of batches) {
    if (!byLine.has(b.line)) byLine.set(b.line, []);
    byLine.get(b.line).push(b);
  }
  for (const list of byLine.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (list[i].startMs < list[j].endMs && list[j].startMs < list[i].endMs) {
          return true;
        }
      }
    }
  }
  return false;
}

// Direct verification of a complete assignment against every constraint.
// assignment: { batchId: { parentId: quantity } }. Returns a list of
// human-readable violations; empty means the assignment is legal.
export function checkAssignment(input, assignment) {
  const violations = [];
  const materials = new Map(input.materials.map((m) => [m.id, m]));
  const batches = new Map(input.batches.map((b) => [b.id, b]));
  const quarantined = new Set(
    [...materials.values(), ...batches.values()]
      .filter((x) => x.status === 'quarantined')
      .map((x) => x.id),
  );
  const expiryOf = (id) => (materials.get(id) ?? batches.get(id)).expiryMs;
  const availableOf = (id) => materials.get(id)?.quantity ?? batches.get(id)?.output;

  for (const b of input.batches) {
    const edges = assignment[b.id] ?? {};
    let sum = 0;
    for (const [p, q] of Object.entries(edges)) {
      if (!b.candidates.includes(p)) {
        violations.push(`${b.id}: ${p} is not a declared candidate parent`);
        continue;
      }
      if (!Number.isInteger(q) || q <= 0) {
        violations.push(`${b.id}: quantity for ${p} must be a positive integer, got ${q}`);
        continue;
      }
      if (b.expiryMs > expiryOf(p)) {
        violations.push(`${b.id}: expiry is later than parent ${p}`);
      }
      sum += q;
    }
    if (sum !== b.output + b.loss) {
      violations.push(`${b.id}: inputs sum to ${sum}, expected ${b.output + b.loss}`);
    }
  }

  // No direct or indirect use of quarantined lots.
  const reaches = (id, seen) => {
    if (quarantined.has(id)) return true;
    const b = batches.get(id);
    if (!b || seen.has(id)) return false;
    seen.add(id);
    return Object.keys(assignment[id] ?? {}).some((p) => reaches(p, seen));
  };
  for (const b of input.batches) {
    if (reaches(b.id, new Set())) {
      violations.push(`${b.id}: directly or indirectly uses a quarantined lot`);
    }
  }

  const used = new Map();
  for (const edges of Object.values(assignment)) {
    for (const [p, q] of Object.entries(edges)) {
      used.set(p, (used.get(p) ?? 0) + q);
    }
  }
  for (const [p, q] of used) {
    if (q > availableOf(p)) {
      violations.push(`${p}: consumed ${q} beyond available ${availableOf(p)}`);
    }
  }

  if (hasLineOverlap(input.batches)) {
    violations.push('batches on the same line overlap in time');
  }
  return violations;
}

// Enumerate all legal assignments (parent subsets x quantity splits).
// `limit` caps the number of yielded solutions.
export function* enumerateAssignments(input, { limit = 1000 } = {}) {
  if (hasLineOverlap(input.batches)) return;
  const materials = new Map(input.materials.map((m) => [m.id, m]));
  const batches = new Map(input.batches.map((b) => [b.id, b]));
  const expiryOf = (id) => (materials.get(id) ?? batches.get(id)).expiryMs;
  const availableOf = (id) => materials.get(id)?.quantity ?? batches.get(id)?.output;

  // Per batch, every quantity split over every candidate subset, filtered by
  // the edge-local expiry rule. Subsets arise naturally from zero entries.
  const options = input.batches.map((b) => {
    const need = b.output + b.loss;
    const caps = b.candidates.map((p) => Math.min(availableOf(p), need));
    const list = [];
    for (const combo of tuples(caps, need)) {
      const edges = {};
      let ok = true;
      for (let j = 0; j < b.candidates.length; j += 1) {
        if (combo[j] === 0) continue;
        const p = b.candidates[j];
        if (b.expiryMs > expiryOf(p)) {
          ok = false;
          break;
        }
        edges[p] = combo[j];
      }
      if (ok) list.push(edges);
    }
    return list;
  });
  if (options.some((list) => list.length === 0)) return;

  let yielded = 0;
  const picked = new Array(input.batches.length);
  const used = new Map();
  function* rec(i) {
    if (yielded >= limit) return;
    if (i === options.length) {
      const assignment = {};
      for (let j = 0; j < picked.length; j += 1) assignment[input.batches[j].id] = picked[j];
      if (checkAssignment(input, assignment).length === 0) {
        yielded += 1;
        yield assignment;
      }
      return;
    }
    for (const edges of options[i]) {
      let fits = true;
      for (const [p, q] of Object.entries(edges)) {
        if ((used.get(p) ?? 0) + q > availableOf(p)) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      for (const [p, q] of Object.entries(edges)) used.set(p, (used.get(p) ?? 0) + q);
      picked[i] = edges;
      yield* rec(i + 1);
      for (const [p, q] of Object.entries(edges)) used.set(p, used.get(p) - q);
    }
  }
  yield* rec(0);
}
