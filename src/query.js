'use strict';

const { parse } = require('./parser');
const { check } = require('./checker');
const { compile } = require('./compiler');
const { run } = require('./vm');
const { openDb, cmpRecord } = require('./storage');

function makeEvaluator(compiled) {
  return (record) => {
    const ctx = {
      record,
      slots: new Array(compiled.slots.length),
      consts: compiled.consts,
      regexes: compiled.regexes,
    };
    for (let i = 0; i < compiled.slots.length; i++) {
      ctx.slots[i] = run(compiled.slots[i], ctx);
    }
    return run(compiled.main, ctx);
  };
}

function computeAggregates(select, matched) {
  const result = {};
  for (const agg of select) {
    const key = agg.field ? `${agg.fn}(${agg.field})` : `${agg.fn}()`;
    if (agg.fn === 'count') {
      result[key] = matched.length;
      continue;
    }
    const values = matched.map((r) => r[agg.field]).filter((v) => v != null);
    if (agg.fn === 'sum') {
      result[key] = values.reduce((a, b) => a + b, 0);
    } else if (agg.fn === 'avg') {
      result[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    } else if (agg.fn === 'min') {
      result[key] = values.length ? Math.min(...values) : null;
    } else if (agg.fn === 'max') {
      result[key] = values.length ? Math.max(...values) : null;
    }
  }
  return result;
}

function executeQuery(dir, source) {
  const program = parse(source);
  check(program);
  const compiled = compile(program);
  const db = openDb(dir);
  const matches = makeEvaluator(compiled);
  const matched = [];
  const { bounds } = compiled;
  for (const seg of db.segments) {
    if (bounds && seg.index) {
      if (seg.index.maxTs < bounds.lo || seg.index.minTs > bounds.hi) continue;
    }
    for (const rec of seg.records) {
      if (matches(rec)) matched.push(rec);
    }
  }
  for (const rec of db.walRecords) {
    if (matches(rec)) matched.push(rec);
  }
  matched.sort(cmpRecord);
  if (compiled.select) {
    return { kind: 'aggregate', result: computeAggregates(compiled.select, matched) };
  }
  return { kind: 'records', records: matched };
}

module.exports = { executeQuery };
