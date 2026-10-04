import { predString } from './planner.js';

function label(node) {
  switch (node.type) {
    case 'scan': {
      const base = node.index
        ? `IndexScan(${node.table}@${node.index.name})`
        : `SeqScan(${node.table})`;
      return node.predicates.length
        ? `${base} [${node.predicates.map(predString).join(', ')}]`
        : base;
    }
    case 'filter':
      return `Filter(${node.predicates.map(predString).join(', ')})`;
    case 'join': {
      const name = node.joinType === 'left' ? 'LeftJoin' : 'InnerJoin';
      return `${name}(${node.cond.map((pair) => pair.join('=')).join(' & ')})`;
    }
    case 'groupby': {
      const aggs = node.aggregates.map((a) => `${a.fn}(${a.col}) AS ${a.as}`).join(', ');
      return `GroupBy(keys=[${node.keys.join(', ')}] aggs=[${aggs}])`;
    }
    default:
      return `Unknown(${node.type})`;
  }
}

export function renderPlan(node, indent = '') {
  const lines = [indent + label(node)];
  if (node.input) lines.push(renderPlan(node.input, indent + '  '));
  if (node.left) lines.push(renderPlan(node.left, indent + '  '));
  if (node.right) lines.push(renderPlan(node.right, indent + '  '));
  return lines.join('\n');
}
