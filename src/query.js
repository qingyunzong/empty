import { hasColumn, tableStats } from './catalog.js';

export const OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);
export const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);

export function parseQualified(name) {
  if (typeof name !== 'string') throw new Error(`column must be a qualified string, got: ${JSON.stringify(name)}`);
  const parts = name.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`column must be qualified as <table>.<column>: ${name}`);
  }
  return { table: parts[0], column: parts[1] };
}

function checkColumn(catalog, scope, name) {
  const { table, column } = parseQualified(name);
  if (!scope.has(table)) throw new Error(`unknown column: ${name} (table not in scope)`);
  if (!hasColumn(catalog, table, column)) throw new Error(`unknown column: ${name}`);
  return { table, column, qualified: name };
}

function normalizePredicate(catalog, scope, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`invalid predicate: ${JSON.stringify(raw)}`);
  const { col, op, value } = raw;
  if (!OPS.has(op)) throw new Error(`unsupported operator: ${op}`);
  const checked = checkColumn(catalog, scope, col);
  return { col: checked.qualified, op, value, tables: new Set([checked.table]) };
}

function normalizeJoinCond(catalog, scope, raw, rightTable) {
  if (!raw || typeof raw !== 'object') throw new Error('join requires an "on" object {left, right}');
  const left = checkColumn(catalog, scope, raw.left);
  const right = checkColumn(catalog, scope, raw.right);
  if (rightTable) {
    // left join: exactly one side must reference the new (right) table
    if (left.table === rightTable && right.table !== rightTable) {
      return { lcol: right.qualified, rcol: left.qualified };
    }
    if (right.table === rightTable && left.table !== rightTable) {
      return { lcol: left.qualified, rcol: right.qualified };
    }
    throw new Error(`left join condition must reference the joined table ${rightTable} and the left side`);
  }
  return { lcol: left.qualified, rcol: right.qualified };
}

export function validateQuery(catalog, query) {
  if (!query || typeof query !== 'object') throw new Error('query must be a JSON object');
  const { from } = query;
  if (!from) throw new Error('query requires "from"');
  tableStats(catalog, from);
  const scope = new Set([from]);

  const joins = [];
  const innerConds = [];
  const leftJoins = [];
  for (const raw of query.joins ?? []) {
    const { type, table } = raw;
    if (type !== 'inner' && type !== 'left') throw new Error(`unsupported join type: ${type}`);
    tableStats(catalog, table);
    if (scope.has(table)) throw new Error(`table joined twice: ${table}`);
    scope.add(table);
    if (type === 'left') {
      const cond = normalizeJoinCond(catalog, scope, raw.on, table);
      leftJoins.push(cond);
      joins.push({ type, table, cond });
    } else {
      const cond = normalizeJoinCond(catalog, scope, raw.on, null);
      innerConds.push(cond);
      joins.push({ type, table, cond });
    }
  }

  const where = (query.where ?? []).map((p) => normalizePredicate(catalog, scope, p));

  let groupBy = null;
  if (query.groupBy) {
    const keys = (query.groupBy.keys ?? []).map((k) => checkColumn(catalog, scope, k).qualified);
    const aggregates = [];
    const aliases = new Set();
    for (const raw of query.groupBy.aggregates ?? []) {
      if (!AGG_FNS.has(raw.fn)) throw new Error(`unsupported aggregate: ${raw.fn}`);
      if (!raw.as) throw new Error('aggregate requires "as" alias');
      if (aliases.has(raw.as)) throw new Error(`duplicate aggregate alias: ${raw.as}`);
      aliases.add(raw.as);
      if (raw.col !== undefined && typeof raw.col === 'object') {
        throw new Error(`nested aggregate is not allowed: ${raw.as}`);
      }
      if (raw.col === '*') {
        if (raw.fn !== 'count') throw new Error(`only count(*) is allowed, got ${raw.fn}(*)`);
        aggregates.push({ fn: raw.fn, col: '*', as: raw.as });
        continue;
      }
      if (typeof raw.col !== 'string') throw new Error(`aggregate ${raw.as} requires "col"`);
      if (aliases.has(raw.col) || (query.groupBy.aggregates ?? []).some((a) => a.as === raw.col)) {
        throw new Error(`nested aggregate is not allowed: ${raw.as} references aggregate ${raw.col}`);
      }
      const checked = checkColumn(catalog, scope, raw.col);
      aggregates.push({ fn: raw.fn, col: checked.qualified, as: raw.as });
    }
    groupBy = { keys, aggregates };
  }

  return { from, joins, innerConds, leftJoins, where, groupBy, tables: [...scope] };
}
