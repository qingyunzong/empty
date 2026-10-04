export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
  }
}

export const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);

const OPS = new Map([
  ['=', '='], ['eq', '='],
  ['!=', '!='], ['neq', '!='],
  ['<', '<'], ['lt', '<'],
  ['<=', '<='], ['lte', '<='],
  ['>', '>'], ['gt', '>'],
  ['>=', '>='], ['gte', '>='],
]);

function normalizeOp(op) {
  const normalized = OPS.get(op);
  if (!normalized) throw new QueryError(`invalid operator: ${op}`);
  return normalized;
}

function checkColumn(ref, catalog, tables) {
  if (typeof ref !== 'string' || !ref.includes('.')) {
    throw new QueryError(`invalid column reference: ${String(ref)}`);
  }
  const [table, column] = ref.split('.');
  if (!tables.includes(table)) {
    throw new QueryError(`unknown table in column reference: ${ref}`);
  }
  const tdef = catalog.tables[table];
  if (!tdef.columns || !(column in tdef.columns)) {
    throw new QueryError(`unknown column: ${ref}`);
  }
  return ref;
}

function checkAggregate(agg, catalog, tables) {
  if (!agg || typeof agg !== 'object') throw new QueryError('aggregate must be an object');
  if (!AGG_FNS.has(agg.fn)) throw new QueryError(`unknown aggregate function: ${agg.fn}`);
  if (agg.col === '*') {
    if (agg.fn !== 'count') throw new QueryError(`aggregate ${agg.fn} does not accept *`);
  } else if (typeof agg.col !== 'string') {
    throw new QueryError('nested aggregate is not allowed');
  } else {
    checkColumn(agg.col, catalog, tables);
  }
  const as = agg.as ?? `${agg.fn}_${agg.col === '*' ? 'star' : agg.col.replace('.', '_')}`;
  return { fn: agg.fn, col: agg.col, as };
}

// Validates a raw JSON query against the catalog and returns a normalized copy
// (canonical operators, defaults filled). Throws QueryError on any illegality.
export function validateQuery(query, catalog) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new QueryError('query must be a JSON object');
  }
  if (!catalog.tables[query.scan]) throw new QueryError(`unknown table: ${query.scan}`);
  const tables = [query.scan];
  const joins = (query.joins ?? []).map((j) => {
    if (j.type !== 'inner' && j.type !== 'left') {
      throw new QueryError(`invalid join type: ${j.type}`);
    }
    if (!catalog.tables[j.table]) throw new QueryError(`unknown table: ${j.table}`);
    if (tables.includes(j.table)) throw new QueryError(`duplicate table: ${j.table}`);
    tables.push(j.table);
    if (!Array.isArray(j.on) || j.on.length === 0) {
      throw new QueryError(`join on ${j.table} requires a non-empty on`);
    }
    const on = j.on.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new QueryError('join condition must be a pair of columns');
      }
      checkColumn(pair[0], catalog, tables);
      checkColumn(pair[1], catalog, tables);
      if (pair[0].split('.')[0] === pair[1].split('.')[0]) {
        throw new QueryError('join condition must reference two different tables');
      }
      return [pair[0], pair[1]];
    });
    return { type: j.type, table: j.table, on };
  });
  const filter = (query.filter ?? []).map((f) => {
    checkColumn(f.col, catalog, tables);
    const op = normalizeOp(f.op);
    if (f.value === null || typeof f.value === 'object') {
      throw new QueryError('filter value must be a non-null scalar');
    }
    return { col: f.col, op, value: f.value };
  });
  let groupBy = null;
  if (query.groupBy) {
    const keys = (query.groupBy.keys ?? []).map((k) => checkColumn(k, catalog, tables));
    const aggregates = (query.groupBy.aggregates ?? []).map((a) => checkAggregate(a, catalog, tables));
    groupBy = { keys, aggregates };
  }
  return { scan: query.scan, joins, filter, groupBy };
}
