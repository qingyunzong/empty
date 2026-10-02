import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Independent full-enumeration reference. Recomputes every sensor from
 * scratch by walking its whole reference chain on each call. Used by the
 * differential tests to validate the incremental implementation.
 */
export function computeReference(state) {
  const { sensors, bases } = state;
  const ids = Object.keys(sensors).sort(compareIds);
  const results = {};
  for (const id of ids) {
    const chain = [];
    const visited = new Set();
    let blocked = false;
    let cur = id;
    for (;;) {
      if (visited.has(cur)) {
        blocked = true;
        break;
      }
      visited.add(cur);
      chain.push(sensors[cur]);
      const base = bases[cur];
      if (base === undefined) break;
      if (!Object.hasOwn(sensors, base)) {
        blocked = true;
        break;
      }
      cur = base;
    }
    let value = null;
    if (!blocked) {
      let acc = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const c = chain[i];
        acc = acc === null ? c.raw * c.scale + c.offset : acc * c.scale + c.offset;
      }
      value = acc;
    }
    results[id] = { id, value, blocked, confidence: blocked ? 0 : 1 };
  }
  const coefficients = ids.map((id) => {
    const c = sensors[id];
    return [id, c.raw, c.offset, c.scale];
  });
  const edges = Object.keys(bases).sort(compareIds).map((id) => [id, bases[id]]);
  return {
    results,
    certificate: {
      coefficientsHash: sha256(JSON.stringify(coefficients)),
      topologyHash: sha256(JSON.stringify(edges)),
      ordering: referenceOrdering(sensors, bases),
    },
  };
}

function referenceOrdering(sensors, bases) {
  const ids = Object.keys(sensors).sort(compareIds);
  const remaining = new Set(ids);
  const order = [];
  while (remaining.size > 0) {
    const emitted = new Set(order);
    let progressed = false;
    for (const id of ids) {
      if (!remaining.has(id)) continue;
      const base = bases[id];
      if (base === undefined || !Object.hasOwn(sensors, base) || emitted.has(base)) {
        order.push(id);
        remaining.delete(id);
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      const [first] = [...remaining].sort(compareIds);
      order.push(first);
      remaining.delete(first);
    }
  }
  return order;
}
