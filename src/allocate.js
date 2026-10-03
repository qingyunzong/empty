'use strict';

const { SubstituteGraph, compareValues } = require('./model');

// Compute the full deterministic allocation for a state.
//
// Reservation order: orders sorted by (due, id), lines by line number.
// Within a line, stock is consumed FEFO: batches sorted by (expiry, id).
// Only OK, non-expired batches whose material can substitute for the
// required material (reflexive transitive closure of the substitute DAG)
// are eligible.
//
// Because lines are processed in reservation order and each line greedily
// takes the earliest-expiring eligible units, the result equals the
// lexicographic optimum over all feasible matchings where the objective
// is, per line in reservation order: maximize fill, then minimize the
// sorted (expiry, batchId) vector of consumed units.
function allocate(state) {
  const graph = new SubstituteGraph(state.substitutes);
  const now = state.now ?? null;

  const remaining = new Map();
  for (const batch of state.batches) remaining.set(batch.id, batch.qty);

  const isUsable = (batch) =>
    batch.status === 'OK' &&
    remaining.get(batch.id) > 0 &&
    !(now !== null && batch.expiry < now);

  const closureCache = new Map();
  const closure = (material) => {
    let set = closureCache.get(material);
    if (!set) {
      set = graph.reachableFrom(material);
      closureCache.set(material, set);
    }
    return set;
  };

  const orders = [...state.orders].sort(
    (a, b) => compareValues(a.due, b.due) || compareValues(a.id, b.id)
  );

  const reservations = [];
  const orderResults = [];

  for (const order of orders) {
    const lines = [...order.lines].sort((a, b) => compareValues(a.line, b.line));
    const lineResults = [];

    for (const line of lines) {
      const materials = closure(line.material);

      // What the allocator could try for this line, right now: every
      // substitute material and how much usable stock it still has.
      const attempted = [...materials].sort(compareValues).map((material) => ({
        material,
        available: state.batches.reduce(
          (sum, batch) =>
            sum + (batch.material === material && isUsable(batch) ? remaining.get(batch.id) : 0),
          0
        ),
      }));

      const eligible = state.batches
        .filter((batch) => materials.has(batch.material) && isUsable(batch))
        .sort((a, b) => compareValues(a.expiry, b.expiry) || compareValues(a.id, b.id));

      let need = line.qty;
      const allocations = [];
      for (const batch of eligible) {
        if (need <= 0) break;
        const take = Math.min(need, remaining.get(batch.id));
        if (take <= 0) continue;
        remaining.set(batch.id, remaining.get(batch.id) - take);
        allocations.push({
          batchId: batch.id,
          batchMaterial: batch.material,
          qty: take,
          expiry: batch.expiry,
        });
        reservations.push({
          orderId: order.id,
          line: line.line,
          batchId: batch.id,
          material: line.material,
          batchMaterial: batch.material,
          qty: take,
          expiry: batch.expiry,
        });
        need -= take;
      }

      lineResults.push({
        line: line.line,
        material: line.material,
        required: line.qty,
        reserved: line.qty - need,
        short: need,
        allocations,
        attempted,
      });
    }

    const status = lineResults.every((line) => line.short === 0) ? 'COMPLETE' : 'SHORT';
    const shortLines = lineResults.filter((line) => line.short > 0);
    const certificate =
      status === 'SHORT'
        ? {
            missing: shortLines.map((line) => ({
              line: line.line,
              material: line.material,
              required: line.required,
              reserved: line.reserved,
              short: line.short,
            })),
            attemptedSubstitutes: shortLines.map((line) => ({
              line: line.line,
              material: line.material,
              tried: line.attempted,
            })),
          }
        : null;

    orderResults.push({
      orderId: order.id,
      due: order.due,
      status,
      lines: lineResults,
      certificate,
    });
  }

  const batchResults = state.batches.map((batch) => ({
    id: batch.id,
    material: batch.material,
    qty: batch.qty,
    expiry: batch.expiry,
    status: batch.status,
    reserved: batch.qty - remaining.get(batch.id),
    available: remaining.get(batch.id),
  }));

  return {
    now: state.now ?? null,
    reservations,
    orders: orderResults,
    batches: batchResults,
    substitutes: state.substitutes.map((edge) => [...edge]),
  };
}

module.exports = { allocate };
