// Traceability views as Moore-style DFAs.
//
// A view is { alphabet, start, states: Map<name, { defects, pending, on }> }.
// - defects: sorted unique defect ids reachable through the lineage (the
//   "reachable defect set" of that view state).
// - pending: true while a test/inspection outcome is undecided. Pending states
//   are real states; they are never treated as unsatisfiable or pruned.
// - on: Map<symbol, name>. A missing transition targets an implicit sink
//   (empty defect set, not pending, self-loops on every symbol).

export const DEFAULT_ALPHABET = Object.freeze(['merge', 'split', 'test', 'ship']);

export function makeView(alphabet = DEFAULT_ALPHABET) {
  return { alphabet: [...alphabet], start: null, states: new Map() };
}

export function stateOf(view, name) {
  if (name === null) return { defects: [], pending: false, on: new Map() };
  return view.states.get(name);
}

export function step(view, name, symbol) {
  if (name === null) return null;
  const state = view.states.get(name);
  const target = state && state.on ? state.on.get(symbol) : undefined;
  return target === undefined ? null : target;
}

export function reachableNames(view) {
  const seen = new Set();
  if (view.start === null || view.start === undefined) return seen;
  const queue = [view.start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const symbol of view.alphabet) queue.push(step(view, current, symbol));
  }
  return seen;
}

export function sameDefects(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function labelOf(view, name) {
  const state = stateOf(view, name);
  return `${state.pending ? 1 : 0}${state.defects.join('')}`;
}

// Partition-refinement minimization over the reachable part of the view.
// The initial partition keys on (pending, defect set), so merged classes
// preserve the reachable defect set of every member by construction.
export function minimizeDfa(view) {
  const names = [...reachableNames(view)];
  if (names.length === 0) {
    return { minStates: 0, classOf: new Map(), view: makeView(view.alphabet) };
  }

  let classOf = new Map();
  {
    const sigToId = new Map();
    for (const name of names) {
      const sig = labelOf(view, name);
      if (!sigToId.has(sig)) sigToId.set(sig, sigToId.size);
      classOf.set(name, sigToId.get(sig));
    }
  }

  for (;;) {
    const previous = new Set(classOf.values()).size;
    const sigToId = new Map();
    const next = new Map();
    for (const name of names) {
      const transitions = view.alphabet
        .map((symbol) => classOf.get(step(view, name, symbol)))
        .join(',');
      const sig = `${labelOf(view, name)}#${transitions}`;
      if (!sigToId.has(sig)) sigToId.set(sig, sigToId.size);
      next.set(name, sigToId.get(sig));
    }
    classOf = next;
    if (sigToId.size === previous) break;
  }

  const count = new Set(classOf.values()).size;
  const reps = new Array(count);
  for (const name of names) {
    const id = classOf.get(name);
    if (reps[id] === undefined) reps[id] = name;
  }

  const minView = makeView(view.alphabet);
  for (let id = 0; id < count; id += 1) {
    const state = stateOf(view, reps[id]);
    const on = new Map();
    for (const symbol of view.alphabet) {
      on.set(symbol, `q${classOf.get(step(view, reps[id], symbol))}`);
    }
    minView.states.set(`q${id}`, {
      defects: [...state.defects],
      pending: state.pending,
      on,
    });
  }
  minView.start = `q${classOf.get(view.start)}`;

  const namedClassOf = new Map();
  for (const [name, id] of classOf) namedClassOf.set(name, `q${id}`);
  return { minStates: count, classOf: namedClassOf, view: minView };
}

// Union of defect sets over every state reachable from `name` in the view.
export function reachableDefectSet(view, name) {
  const out = new Set();
  const seen = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current !== null) {
      for (const d of view.states.get(current).defects) out.add(d);
    }
    for (const symbol of view.alphabet) queue.push(step(view, current, symbol));
  }
  return [...out].sort();
}

// Shortest-witness equivalence check: BFS over the product of both views
// from the start pair. Returns the shortest symbol string whose two
// endpoints carry different reachable defect sets, or null when equivalent.
export function findWitness(a, b) {
  const startA = a.start ?? null;
  const startB = b.start ?? null;
  const keyOf = (x, y) => `${x === null ? '' : x} ${y === null ? '' : y}`;
  const seen = new Set([keyOf(startA, startB)]);
  const queue = [[startA, startB, []]];
  while (queue.length > 0) {
    const [x, y, path] = queue.shift();
    const defectsX = x === null ? [] : a.states.get(x).defects;
    const defectsY = y === null ? [] : b.states.get(y).defects;
    if (!sameDefects(defectsX, defectsY)) return path;
    for (const symbol of a.alphabet) {
      const nextX = x === null ? null : step(a, x, symbol);
      const nextY = y === null ? null : step(b, y, symbol);
      const key = keyOf(nextX, nextY);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([nextX, nextY, [...path, symbol]]);
      }
    }
  }
  return null;
}
