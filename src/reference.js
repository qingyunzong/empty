'use strict';
// 独立参考算法：迭代 DFS 枚举所有可达节点，用于与递归关系代数结果交叉核对。
function dfsReachable(start, neighbors) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of neighbors(node)) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

function dfsUpstream(edges, lot) {
  return dfsReachable(lot, (n) => edges.filter((e) => e.child === n).map((e) => e.parent));
}

function dfsDownstream(edges, lot) {
  return dfsReachable(lot, (n) => edges.filter((e) => e.parent === n).map((e) => e.child));
}

module.exports = { dfsReachable, dfsUpstream, dfsDownstream };
