export interface AssignmentCost {
  mismatches: number;
  positionDistance: number;
  amountDistance: number;
}

interface FlowEdge {
  to: number;
  rev: number;
  cap: number;
  cost: bigint;
  original: boolean;
}

/**
 * Exact rectangular assignment using min-cost flow. The scalar cost encodes
 * the lexicographic tuple (mismatches, position distance, amount distance).
 */
export function minimumCostAssignment(
  rowCount: number,
  columnCount: number,
  costOf: (row: number, column: number) => AssignmentCost,
): Array<[number, number]> {
  const pairCount = Math.min(rowCount, columnCount);
  if (pairCount === 0) return [];

  let maxPositionDistance = 0;
  let maxAmountDistance = 0;
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const cost = costOf(row, column);
      maxPositionDistance = Math.max(maxPositionDistance, cost.positionDistance);
      maxAmountDistance = Math.max(maxAmountDistance, cost.amountDistance);
    }
  }

  const lowerWeight =
    BigInt(maxAmountDistance) * BigInt(pairCount) + 1n;
  const middleWeight =
    lowerWeight * (BigInt(maxPositionDistance) * BigInt(pairCount) + 1n);

  const source = 0;
  const rowOffset = 1;
  const columnOffset = rowOffset + rowCount;
  const sink = columnOffset + columnCount;
  const graph: FlowEdge[][] = Array.from(
    { length: sink + 1 },
    () => [],
  );

  const addEdge = (
    from: number,
    to: number,
    cap: number,
    cost: bigint,
    original = false,
  ) => {
    const forward: FlowEdge = {
      to,
      rev: graph[to].length,
      cap,
      cost,
      original,
    };
    const reverse: FlowEdge = {
      to: from,
      rev: graph[from].length,
      cap: 0,
      cost: -cost,
      original: false,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
  };

  for (let row = 0; row < rowCount; row += 1) {
    addEdge(source, rowOffset + row, 1, 0n);
  }
  for (let column = 0; column < columnCount; column += 1) {
    addEdge(columnOffset + column, sink, 1, 0n);
  }
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const cost = costOf(row, column);
      const encoded =
        BigInt(cost.mismatches) * middleWeight +
        BigInt(cost.positionDistance) * lowerWeight +
        BigInt(cost.amountDistance);
      addEdge(rowOffset + row, columnOffset + column, 1, encoded, true);
    }
  }

  let flow = 0;
  while (flow < pairCount) {
    const distance: Array<bigint | null> = Array(sink + 1).fill(null);
    const previousNode = Array<number>(sink + 1).fill(-1);
    const previousEdge = Array<number>(sink + 1).fill(-1);
    const inQueue = Array<boolean>(sink + 1).fill(false);
    const queue: number[] = [source];
    distance[source] = 0n;
    inQueue[source] = true;

    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      inQueue[node] = false;
      const nodeDistance = distance[node];
      if (nodeDistance === null) continue;

      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
        const edge = graph[node][edgeIndex];
        if (edge.cap <= 0) continue;
        const candidate = nodeDistance + edge.cost;
        const known = distance[edge.to];
        if (known === null || candidate < known) {
          distance[edge.to] = candidate;
          previousNode[edge.to] = node;
          previousEdge[edge.to] = edgeIndex;
          if (!inQueue[edge.to]) {
            queue.push(edge.to);
            inQueue[edge.to] = true;
          }
        }
      }
    }

    if (distance[sink] === null) break;
    let node = sink;
    while (node !== source) {
      const from = previousNode[node];
      const edgeIndex = previousEdge[node];
      if (from < 0 || edgeIndex < 0) {
        throw new Error("Assignment path reconstruction failed");
      }
      const edge = graph[from][edgeIndex];
      edge.cap -= 1;
      graph[node][edge.rev].cap += 1;
      node = from;
    }
    flow += 1;
  }

  const pairs: Array<[number, number]> = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (const edge of graph[rowOffset + row]) {
      if (!edge.original || edge.cap !== 0) continue;
      pairs.push([row, edge.to - columnOffset]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}
