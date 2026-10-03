import { typeError, unsupported } from './errors.js';

let nextId = 1;
export const mkNode = (type, props) => ({ id: nextId++, type, ...props });

// schema entry: { alias, name, ref } where ref is the qualified internal key "alias.name"
export function schemaOf(node) {
  switch (node.type) {
    case 'scan':
      return node.columns.map((c) => ({ alias: node.alias, name: c, ref: `${node.alias}.${c}` }));
    case 'select':
      return schemaOf(node.input);
    case 'join':
      return [...schemaOf(node.left), ...schemaOf(node.right)];
    case 'groupby':
      return [
        ...node.keyCols.map((k) => ({ ...k })),
        ...node.aggs.map((a) => ({ alias: null, name: a.alias, ref: a.alias })),
      ];
    case 'project':
      return node.items.map((it) => ({ alias: null, name: it.name, ref: it.name }));
    default:
      throw new Error(`schemaOf: unknown node type ${node.type}`);
  }
}

export function resolveCol(schema, col) {
  const matches = col.table
    ? schema.filter((s) => s.alias === col.table && s.name === col.name)
    : schema.filter((s) => s.name === col.name);
  if (matches.length === 0) {
    throw typeError(`unknown column ${col.table ? col.table + '.' : ''}${col.name}`);
  }
  if (matches.length > 1) throw typeError(`ambiguous column ${col.name}`);
  return matches[0].ref;
}

function resolveOperand(op, schema, aggCtx) {
  if (op.kind === 'lit') return op;
  if (op.kind === 'col') return { kind: 'col', ref: resolveCol(schema, op) };
  if (op.kind === 'agg') {
    if (!aggCtx) throw typeError('aggregate functions are only allowed in HAVING / SELECT aggregates');
    const alias = aggCtx.addAgg(op.func, op.arg, null);
    return { kind: 'col', ref: alias };
  }
  throw typeError(`unknown operand kind ${op.kind}`);
}

function resolvePred(expr, schema, aggCtx = null) {
  switch (expr.kind) {
    case 'and':
    case 'or':
      return { kind: expr.kind, args: expr.args.map((a) => resolvePred(a, schema, aggCtx)) };
    case 'not':
      return { kind: 'not', arg: resolvePred(expr.arg, schema, aggCtx) };
    case 'isnull':
      return { kind: 'isnull', operand: resolveOperand(expr.operand, schema, aggCtx), negated: expr.negated };
    case 'cmp':
      return {
        kind: 'cmp',
        op: expr.op,
        left: resolveOperand(expr.left, schema, aggCtx),
        right: resolveOperand(expr.right, schema, aggCtx),
      };
    default:
      throw typeError(`unknown predicate kind ${expr.kind}`);
  }
}

export function collectRefs(expr, into = new Set()) {
  switch (expr.kind) {
    case 'and':
    case 'or':
      for (const a of expr.args) collectRefs(a, into);
      break;
    case 'not':
      collectRefs(expr.arg, into);
      break;
    case 'isnull':
      if (expr.operand.kind === 'col') into.add(expr.operand.ref);
      break;
    case 'cmp':
      for (const o of [expr.left, expr.right]) if (o.kind === 'col') into.add(o.ref);
      break;
    default:
      break;
  }
  return into;
}

export function exprToString(e) {
  switch (e.kind) {
    case 'and': return `(${e.args.map(exprToString).join(' AND ')})`;
    case 'or': return `(${e.args.map(exprToString).join(' OR ')})`;
    case 'not': return `NOT ${exprToString(e.arg)}`;
    case 'isnull': return `${operandToString(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL`;
    case 'cmp': return `${operandToString(e.left)} ${e.op} ${operandToString(e.right)}`;
    default: return '?';
  }
}
function operandToString(o) {
  if (o.kind === 'lit') return JSON.stringify(o.value);
  if (o.kind === 'col') return o.ref;
  return '?';
}

// catalog: { tableName: { columns: [name, ...] } }
export function buildLogicalPlan(ast, catalog) {
  const tableRefs = [ast.from.table, ...ast.from.joins.map((j) => j.table)];
  const seenAliases = new Set();
  for (const t of tableRefs) {
    if (!catalog[t.name]) throw typeError(`unknown table ${t.name}`);
    if (seenAliases.has(t.alias)) throw typeError(`duplicate table alias ${t.alias}`);
    seenAliases.add(t.alias);
  }
  const mkScan = (t) => mkNode('scan', { table: t.name, alias: t.alias, columns: [...catalog[t.name].columns] });

  let plan = mkScan(ast.from.table);
  for (const j of ast.from.joins) {
    const right = mkScan(j.table);
    const leftSchema = schemaOf(plan);
    const rightSchema = schemaOf(right);
    const combined = [...leftSchema, ...rightSchema];
    const leftRefs = new Set(leftSchema.map((s) => s.ref));
    const rightRefs = new Set(rightSchema.map((s) => s.ref));
    const leftKeys = [];
    const rightKeys = [];
    for (const cond of j.on) {
      const rl = resolveCol(combined, cond.left);
      const rr = resolveCol(combined, cond.right);
      if (leftRefs.has(rl) && rightRefs.has(rr)) { leftKeys.push(rl); rightKeys.push(rr); }
      else if (leftRefs.has(rr) && rightRefs.has(rl)) { leftKeys.push(rr); rightKeys.push(rl); }
      else throw unsupported(`JOIN ON condition must reference both sides of the join (${cond.left.name} = ${cond.right.name})`);
    }
    plan = mkNode('join', { left: plan, right, leftKeys, rightKeys });
  }

  if (ast.where) {
    plan = mkNode('select', { input: plan, predicate: resolvePred(ast.where, schemaOf(plan)) });
  }

  const aggs = [];
  const addAgg = (func, arg, alias) => {
    if (arg === '*' && func !== 'count') throw typeError(`${func.toUpperCase()}(*) is not allowed; only COUNT(*) accepts *`);
    const resolved = {
      func,
      arg: arg === '*' ? '*' : resolveCol(schemaOf(plan), arg),
      alias: alias ?? `__agg${aggs.length}`,
    };
    aggs.push(resolved);
    return resolved.alias;
  };

  const hasAggSelect = ast.select.some((i) => i.kind === 'agg');
  const havingHasAgg = ast.having && JSON.stringify(ast.having).includes('"agg"');
  if (ast.groupBy || hasAggSelect || havingHasAgg) {
    const fromSchema = schemaOf(plan);
    const keyCols = (ast.groupBy ?? []).map((c) => {
      const ref = resolveCol(fromSchema, c);
      const entry = fromSchema.find((s) => s.ref === ref);
      return { ...entry };
    });
    const keys = keyCols.map((k) => k.ref);
    for (const item of ast.select) {
      if (item.kind === 'star') throw unsupported('SELECT * with GROUP BY / aggregates is not supported');
      if (item.kind === 'agg') item.aggAlias = addAgg(item.func, item.arg, item.alias);
      if (item.kind === 'col') {
        const ref = resolveCol(fromSchema, item.col);
        if (!keys.includes(ref)) throw typeError(`column ${item.col.name} must appear in GROUP BY or be aggregated`);
      }
    }
    let having = null;
    if (ast.having) {
      having = resolvePred(ast.having, fromSchema, { addAgg });
      const havingRefs = collectRefs(having);
      const aggAliases = new Set(aggs.map((a) => a.alias));
      for (const ref of havingRefs) {
        if (!keys.includes(ref) && !aggAliases.has(ref)) {
          throw typeError(`HAVING references ${ref} which is neither a GROUP BY key nor an aggregate`);
        }
      }
    }
    plan = mkNode('groupby', { input: plan, keys, keyCols, aggs, having });
  }

  const outSchema = schemaOf(plan);
  const items = [];
  for (const item of ast.select) {
    if (item.kind === 'star') {
      for (const s of outSchema) items.push({ name: s.name, ref: s.ref });
    } else if (item.kind === 'col') {
      const ref = resolveCol(outSchema, item.col);
      items.push({ name: item.alias ?? item.col.name, ref });
    } else if (item.kind === 'agg') {
      items.push({ name: item.alias ?? `${item.func}(${item.arg === '*' ? '*' : item.arg.name})`, ref: item.aggAlias });
    }
  }
  plan = mkNode('project', { input: plan, items });
  return plan;
}
