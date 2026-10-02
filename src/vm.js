export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

const ref = (id) => ({ kind: 'ref', id });
const setOf = (ids) => ({ kind: 'set', ids });
const pathOf = (ids) => ({ kind: 'path', ids });

function startIds(value) {
  if (value.kind === 'ref') return [value.id];
  if (value.kind === 'set') return value.ids;
  throw new RuntimeError(`expected node or node set, got ${value.kind}`);
}

function requireRef(value, what) {
  if (value.kind !== 'ref') throw new RuntimeError(`${what} expects a node reference, got ${value.kind}`);
  return value.id;
}

function compare(a, b) {
  if (a === undefined || b === undefined) return undefined;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function runPredicate(instructions, constants, node) {
  const stack = [];
  const prop = (name) => {
    if (name === 'id') return node.id;
    if (name === 'type') return node.type;
    return node.props?.[name];
  };
  for (const [op, arg] of instructions) {
    switch (op) {
      case 'PUSH_CONST': stack.push(constants[arg]); break;
      case 'LOAD_PROP': stack.push(prop(constants[arg])); break;
      case 'NOT': stack.push(!stack.pop()); break;
      case 'AND': { const b = stack.pop(); const a = stack.pop(); stack.push(Boolean(a && b)); break; }
      case 'OR': { const b = stack.pop(); const a = stack.pop(); stack.push(Boolean(a || b)); break; }
      default: {
        const b = stack.pop();
        const a = stack.pop();
        const c = compare(a, b);
        stack.push(
          op === 'EQ' ? c === 0 :
          op === 'NE' ? c !== 0 && c !== undefined :
          op === 'LT' ? c !== undefined && c < 0 :
          op === 'LE' ? c !== undefined && c <= 0 :
          op === 'GT' ? c !== undefined && c > 0 :
          op === 'GE' ? c !== undefined && c >= 0 : false);
      }
    }
  }
  return Boolean(stack.pop());
}

export function run(program, graph) {
  const { instructions, constants } = program;
  const slots = [];
  const stack = [];
  const output = [];

  for (const [op, ...args] of instructions) {
    switch (op) {
      case 'PUSH_CONST': stack.push(constants[args[0]]); break;
      case 'NODE_REF': {
        const id = constants[args[0]];
        if (!graph.hasNode(id)) throw new RuntimeError(`unknown lot '${id}'`);
        stack.push(ref(id));
        break;
      }
      case 'STORE_SLOT': slots[args[0]] = stack.pop(); break;
      case 'LOAD_SLOT': stack.push(slots[args[0]]); break;
      case 'NODES': stack.push(setOf(graph.nodeIds())); break;
      case 'ANCESTORS': stack.push(setOf(graph.ancestorsOf(startIds(stack.pop())))); break;
      case 'DESCENDANTS': stack.push(setOf(graph.descendantsOf(startIds(stack.pop())))); break;
      case 'SHORTEST_PATH': {
        const to = requireRef(stack.pop(), 'shortestPath');
        const from = requireRef(stack.pop(), 'shortestPath');
        stack.push(pathOf(graph.shortestPath(from, to)));
        break;
      }
      case 'FILTER': {
        const value = stack.pop();
        if (value.kind !== 'set') throw new RuntimeError(`where clause requires a node set, got ${value.kind}`);
        const pred = constants[args[0]];
        stack.push(setOf(value.ids.filter((id) =>
          runPredicate(pred, constants, graph.getNode(id)))));
        break;
      }
      case 'SORT': {
        const value = stack.pop();
        if (value.kind === 'path') { stack.push(value); break; }
        if (value.kind !== 'set') throw new RuntimeError(`order by requires a node set, got ${value.kind}`);
        const key = constants[args[0]];
        const dir = args[1] === 'desc' ? -1 : 1;
        const ids = [...value.ids].sort((a, b) => {
          const na = graph.getNode(a);
          const nb = graph.getNode(b);
          const ka = key === 'id' ? na.id : key === 'type' ? na.type : na.props?.[key];
          const kb = key === 'id' ? nb.id : key === 'type' ? nb.type : nb.props?.[key];
          const c = compare(ka, kb);
          if (c === undefined) return a < b ? -1 : 1;
          return c !== 0 ? c * dir : a < b ? -1 : a > b ? 1 : 0;
        });
        stack.push(setOf(ids));
        break;
      }
      case 'EMIT': output.push(stack.pop()); break;
      default: throw new RuntimeError(`bad opcode ${op}`);
    }
  }
  return output;
}
