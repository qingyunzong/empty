import { PositionalIndex } from './index.js';
import { Forest } from './tree.js';
import { UndoError, ERR } from './errors.js';

// Pure planning step: validates the request and computes the exact undo set.
// Throws UndoError for ROOT_NOT_FOUND / CYCLE_DETECTED / ALREADY_UNDONE /
// BUDGET_EXCEEDED; on any throw nothing is mutated or persisted.
export function planUndo(nodes, { rootId, terms, slop, budget }) {
  if (!Array.isArray(terms) || terms.length !== 2) {
    throw new UndoError(ERR.BAD_REQUEST, 'terms must be a [first, second] pair');
  }
  if (typeof budget !== 'number' || Number.isNaN(budget) || budget < 0) {
    throw new UndoError(ERR.BAD_REQUEST, `budget must be a non-negative number, got: ${budget}`);
  }
  const forest = new Forest(nodes);
  if (!forest.nodes.has(rootId)) {
    throw new UndoError(ERR.ROOT_NOT_FOUND, `root node not found: ${rootId}`, { rootId });
  }
  forest.assertAcyclicChain(rootId);
  const subtree = forest.collectSubtree(rootId);
  for (const id of subtree) forest.assertAcyclicChain(id);

  const index = PositionalIndex.fromNodes(subtree.map((id) => forest.nodes.get(id)));
  const hits = index.near(terms[0], terms[1], slop);
  const hitIds = [...hits.keys()].sort();

  const undoSet = new Set();
  for (const id of hitIds) {
    for (const descendant of forest.collectSubtree(id)) undoSet.add(descendant);
  }

  const alreadyUndone = [...undoSet]
    .filter((id) => forest.nodes.get(id).state === 'undone')
    .sort();
  if (alreadyUndone.length > 0) {
    throw new UndoError(ERR.ALREADY_UNDONE, `nodes already undone: ${alreadyUndone.join(', ')}`, {
      nodes: alreadyUndone,
    });
  }

  const levels = forest.levelsFrom(rootId);
  let totalAmount = 0;
  for (const id of undoSet) totalAmount += forest.nodes.get(id).amount;
  if (totalAmount > budget) {
    throw new UndoError(
      ERR.BUDGET_EXCEEDED,
      `undo total ${totalAmount} exceeds budget ${budget}`,
      { required: totalAmount, budget },
    );
  }

  return { forest, rootId, terms, slop, budget, hits, hitIds, undoSet, levels, totalAmount };
}

// Builds the deterministic compensation certificate for a validated plan.
export function buildCertificate(plan, batch) {
  const nodes = [...plan.undoSet].sort().map((id) => {
    const node = plan.forest.nodes.get(id);
    return {
      id,
      level: plan.levels.get(id),
      amount: node.amount,
      matched: plan.hits.has(id),
      positions: plan.hits.get(id) ?? [],
    };
  });
  return {
    batch,
    rootId: plan.rootId,
    terms: [...plan.terms],
    slop: plan.slop,
    budget: plan.budget,
    totalAmount: plan.totalAmount,
    nodeCount: nodes.length,
    nodes,
  };
}

// Full undo command: plan, then persist via the store. The store's COMMIT
// marker is written last, so any crash mid-way replays as "not undone".
export function undo(store, nodes, options) {
  const committed = store.load();
  const undoneSoFar = new Set(committed.undone);
  const effectiveNodes = nodes.map((node) =>
    undoneSoFar.has(node.id) ? { ...node, state: 'undone' } : node,
  );
  const plan = planUndo(effectiveNodes, options);
  const batch = committed.batch + 1;
  const certificate = buildCertificate(plan, batch);
  const undone = [...undoneSoFar, ...plan.undoSet];
  store.commit(batch, { undone, certificate });
  return certificate;
}
