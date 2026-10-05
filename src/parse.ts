import { MAX_EDGES, type Edge, type Pair, type Problem, type ProblemInput } from './types.js';

export class InputError extends Error {}

function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

/** Validate and normalize raw JSON input into a Problem. Throws InputError. */
export function parseProblem(raw: unknown): Problem {
  if (typeof raw !== 'object' || raw === null) throw new InputError('input must be a JSON object');
  const inp = raw as ProblemInput;

  if (!Array.isArray(inp.nodes) || inp.nodes.some((n) => typeof n !== 'string')) {
    throw new InputError('"nodes" must be an array of strings');
  }
  const nodes = [...inp.nodes];
  const nodeSet = new Set(nodes);
  if (nodeSet.size !== nodes.length) throw new InputError('duplicate node names');

  if (!Array.isArray(inp.edges)) throw new InputError('"edges" must be an array');
  if (inp.edges.length > MAX_EDGES) {
    throw new InputError(`too many edges: ${inp.edges.length} > ${MAX_EDGES}`);
  }
  const ids = new Set<string>();
  const edges: Edge[] = inp.edges.map((e, i) => {
    if (typeof e !== 'object' || e === null) throw new InputError(`edge #${i} must be an object`);
    if (typeof e.id !== 'string' || e.id === '') throw new InputError(`edge #${i}: "id" must be a non-empty string`);
    if (ids.has(e.id)) throw new InputError(`duplicate edge id "${e.id}"`);
    ids.add(e.id);
    if (!nodeSet.has(e.from)) throw new InputError(`edge "${e.id}": unknown from-node "${e.from}"`);
    if (!nodeSet.has(e.to)) throw new InputError(`edge "${e.id}": unknown to-node "${e.to}"`);
    const cost = e.cost ?? 1;
    if (!isNonNegInt(cost)) throw new InputError(`edge "${e.id}": "cost" must be a non-negative integer`);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      cost,
      locked: e.locked ?? false,
      group: e.group ?? null,
    };
  });

  const pairs: Pair[] = [];
  const entries = inp.entries ?? [];
  const exits = inp.exits ?? [];
  for (const n of [...entries, ...exits]) {
    if (!nodeSet.has(n)) throw new InputError(`unknown entry/exit node "${n}"`);
  }
  for (const a of entries) for (const b of exits) pairs.push({ from: a, to: b });
  for (const p of inp.preserve ?? []) {
    if (!nodeSet.has(p.from) || !nodeSet.has(p.to)) {
      throw new InputError(`preserve pair references unknown node: ${JSON.stringify(p)}`);
    }
    pairs.push({ from: p.from, to: p.to });
  }
  const pairKey = (p: Pair) => `${p.from} -> ${p.to}`;
  const seenPairs = new Set<string>();
  const uniqPairs = pairs.filter((p) => (seenPairs.has(pairKey(p)) ? false : (seenPairs.add(pairKey(p)), true)));

  let budget = Infinity;
  if (inp.budget !== undefined) {
    if (!isNonNegInt(inp.budget)) throw new InputError('"budget" must be a non-negative integer');
    budget = inp.budget;
  }

  const groupRequires = new Map<string, string[]>();
  const groupNames = new Set(edges.filter((e) => e.group !== null).map((e) => e.group as string));
  for (const [g, cfg] of Object.entries(inp.groups ?? {})) {
    const req = cfg?.requires ?? [];
    if (!Array.isArray(req) || req.some((r) => typeof r !== 'string')) {
      throw new InputError(`group "${g}": "requires" must be an array of group names`);
    }
    groupRequires.set(g, [...req]);
    for (const r of req) groupNames.add(r);
    groupNames.add(g);
  }
  for (const g of groupNames) {
    if (!groupRequires.has(g)) groupRequires.set(g, []);
  }
  // detect cycles in group-requires relation: a cycle would force deleting all of them; that is
  // legal, so no error — but unknown groups referenced by edges are fine (no requires).
  void groupNames;

  return { nodes, edges, pairs: uniqPairs, budget, groupRequires };
}

/**
 * Groups whose edges can never be fully deleted because a required group
 * contains at least one locked edge (transitively closed).
 */
export function impossibleGroups(problem: Problem): Set<string> {
  const lockedGroups = new Set<string>();
  for (const e of problem.edges) {
    if (e.locked && e.group !== null) lockedGroups.add(e.group);
  }
  // group g is impossible if it (transitively) requires a group containing a locked edge
  const impossible = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [g, reqs] of problem.groupRequires) {
      if (impossible.has(g)) continue;
      if (reqs.some((r) => lockedGroups.has(r) || impossible.has(r))) {
        impossible.add(g);
        changed = true;
      }
    }
  }
  return impossible;
}
