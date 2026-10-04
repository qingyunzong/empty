import { hashValue } from './util.js';

export class QueryRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryRuntimeError';
  }
}

const NULL_VALUE = Object.freeze({ kind: 'null', value: null });

function attrValue(node, name) {
  const value = node.attrs[name];
  if (value === undefined) return NULL_VALUE;
  if (name === 'date') return { kind: 'date', value };
  return { kind: 'string', value };
}

function truthy(value) {
  switch (value.kind) {
    case 'bool':
      return value.value;
    case 'null':
      return false;
    case 'string':
      return value.value.length > 0;
    case 'number':
      return value.value !== 0;
    default:
      return true;
  }
}

function eqValue(a, b) {
  return a.kind === b.kind && a.value === b.value;
}

function cmpValue(op, a, b) {
  if (a.kind === 'null' || b.kind === 'null') return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'bool') return false;
  switch (op) {
    case 'LT':
      return a.value < b.value;
    case 'LE':
      return a.value <= b.value;
    case 'GT':
      return a.value > b.value;
    case 'GE':
      return a.value >= b.value;
    default:
      return false;
  }
}

function runFilter(program, node, vars) {
  const stack = [];
  for (const ins of program) {
    switch (ins.op) {
      case 'PUSH':
        stack.push(ins.value);
        break;
      case 'LOAD':
        stack.push(vars[ins.slot]);
        break;
      case 'ATTR':
        stack.push(attrValue(node, ins.name));
        break;
      case 'NOT':
        stack.push({ kind: 'bool', value: !truthy(stack.pop()) });
        break;
      case 'AND': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push({ kind: 'bool', value: truthy(a) && truthy(b) });
        break;
      }
      case 'OR': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push({ kind: 'bool', value: truthy(a) || truthy(b) });
        break;
      }
      case 'EQ': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push({ kind: 'bool', value: eqValue(a, b) });
        break;
      }
      case 'NE': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push({ kind: 'bool', value: !eqValue(a, b) });
        break;
      }
      case 'LT':
      case 'LE':
      case 'GT':
      case 'GE': {
        const b = stack.pop();
        const a = stack.pop();
        stack.push({ kind: 'bool', value: cmpValue(ins.op, a, b) });
        break;
      }
      default:
        throw new QueryRuntimeError(`unknown filter opcode '${ins.op}'`);
    }
  }
  if (stack.length !== 1) throw new QueryRuntimeError('malformed filter program');
  return truthy(stack[0]);
}

function buildWitnesses(value, graph) {
  if (value.kind === 'path') return value.nodes ? [value.nodes] : [];
  const paths = [];
  for (const id of value.ids) {
    const path =
      value.origin.dir === 'ancestors'
        ? graph.shortestPath(id, value.origin.root)
        : graph.shortestPath(value.origin.root, id);
    if (path) paths.push(path);
  }
  return paths;
}

function makeCertificate(source, graph, value, result, paths, program, statementIndex) {
  const pathHashes = paths.map((p) => hashValue(p));
  const body = {
    query: source,
    commandHash: graph.commandHash(),
    graphVersion: graph.version,
    resultKind: value.kind,
    result,
    pathHashes,
  };
  if (program !== null && program !== undefined) {
    body.program = program;
    body.statementIndex = statementIndex;
  }
  return { ...body, paths, hash: hashValue(body) };
}

export function execute(compiled, graph, program = null) {
  const stack = [];
  const vars = new Array(compiled.slots).fill(null);
  const results = [];
  const certificates = [];
  let emitIndex = 0;

  for (const ins of compiled.code) {
    switch (ins.op) {
      case 'PUSH':
        stack.push(ins.value);
        break;
      case 'LOAD':
        stack.push(vars[ins.slot]);
        break;
      case 'STORE':
        vars[ins.slot] = stack.pop();
        break;
      case 'CALL': {
        const args = stack.splice(stack.length - ins.argc, ins.argc);
        if (ins.fn === 'ancestors' || ins.fn === 'descendants') {
          const id = args[0].value;
          if (!graph.hasNode(id)) throw new QueryRuntimeError(`unknown lot '${id}'`);
          const ids = ins.fn === 'ancestors' ? graph.ancestors(id) : graph.descendants(id);
          stack.push({ kind: 'set', ids, origin: { root: id, dir: ins.fn } });
        } else if (ins.fn === 'shortestPath') {
          const from = args[0].value;
          const to = args[1].value;
          if (!graph.hasNode(from)) throw new QueryRuntimeError(`unknown lot '${from}'`);
          if (!graph.hasNode(to)) throw new QueryRuntimeError(`unknown lot '${to}'`);
          stack.push({ kind: 'path', nodes: graph.shortestPath(from, to) });
        } else {
          throw new QueryRuntimeError(`unknown function '${ins.fn}'`);
        }
        break;
      }
      case 'FILTER': {
        const value = stack.pop();
        if (value.kind !== 'set') throw new QueryRuntimeError('cannot filter a non-set value');
        const ids = value.ids.filter((id) => runFilter(ins.program, graph.nodes.get(id), vars));
        stack.push({ ...value, ids });
        break;
      }
      case 'EMIT': {
        const value = stack.pop();
        const result = value.kind === 'set' ? value.ids : value.nodes;
        const paths = buildWitnesses(value, graph);
        results.push({ line: ins.line, query: ins.source, resultKind: value.kind, result });
        certificates.push(makeCertificate(ins.source, graph, value, result, paths, program, emitIndex));
        emitIndex += 1;
        break;
      }
      default:
        throw new QueryRuntimeError(`unknown opcode '${ins.op}'`);
    }
  }
  return { results, certificates };
}
