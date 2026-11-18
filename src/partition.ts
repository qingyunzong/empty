export interface ShardAllocation {
  id: string;
  limit: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export function partitionQuota(
  quota: number,
  nodeIds: readonly string[],
  weights?: readonly number[],
): ShardAllocation[] {
  positiveInteger(quota, 'quota');
  if (nodeIds.length === 0) {
    throw new RangeError('at least one node is required');
  }
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new RangeError('node ids must be unique');
  }
  if (weights !== undefined && weights.length !== nodeIds.length) {
    throw new RangeError('weights must match nodeIds length');
  }

  if (weights === undefined) {
    if (quota < nodeIds.length) {
      throw new RangeError('quota must be at least the number of nodes');
    }
    const base = Math.floor(quota / nodeIds.length);
    const remainder = quota % nodeIds.length;
    return nodeIds.map((id, index) => ({
      id,
      limit: base + (index < remainder ? 1 : 0),
    }));
  }

  const totalWeight = weights.reduce((sum, weight) => {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError('weights must be finite positive numbers');
    }
    return sum + weight;
  }, 0);

  const raw = weights.map((weight) => (quota * weight) / totalWeight);
  const limits = raw.map((value) => Math.floor(value));
  let assigned = limits.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  for (let index = 0; assigned < quota; index += 1) {
    const target = order[index % order.length];
    if (target === undefined) {
      throw new Error('unreachable');
    }
    limits[target.index] = (limits[target.index] as number) + 1;
    assigned += 1;
  }

  return nodeIds.map((id, index) => {
    const limit = limits[index] as number;
    if (limit <= 0) {
      throw new RangeError(`node ${id} received an empty shard; reduce node count or change weights`);
    }
    return { id, limit };
  });
}
