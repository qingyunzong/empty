#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { performance } = require('perf_hooks');
const { QError, E_NON_EQUIV } = require('./errors');
const { parse } = require('./sql');
const { buildPlan, formatPlan } = require('./plan');
const { toDirect, execResult, execute } = require('./physical');
const { loadTables, schemasFromData, runQuery } = require('./engine');
const { resultsEqual, summarizeResult } = require('./verify');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      args[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function loadPlanOrSql(file, schemas) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const obj = JSON.parse(text);
    return obj.optimized || obj.plan || obj;
  }
  return buildPlan(parse(text), schemas);
}

function cmdSql(args, out) {
  const file = args._[0];
  if (!file) throw new QError('E_PARSE', 'usage: sql <file.sql> [--data dir]');
  const data = loadTables(args.data || './data');
  const r = runQuery(fs.readFileSync(file, 'utf8'), data);
  if (r.unknown.length > 0) {
    out.warn(`warning: ${r.unknown.length} group(s) evaluated UNKNOWN in HAVING (reported in unknownRows)`);
  }
  out.print(JSON.stringify({
    rows: r.rows,
    unknownRows: r.unknown,
    havingFalseCount: r.falseCount,
    certificate: r.certificate,
  }, null, 2));
}

function cmdExplain(args, out) {
  const file = args._[0];
  if (!file) throw new QError('E_PARSE', 'usage: explain <file.sql> [--data dir] [--json]');
  const data = loadTables(args.data || './data');
  const r = runQuery(fs.readFileSync(file, 'utf8'), data);
  if (args.json) {
    out.print(JSON.stringify({
      logical: r.logical,
      optimized: r.optimized,
      rules: r.certificate.rules,
      physical: r.physical.map((p) => ({ cost: p.cost, plan: p.plan })),
      certificate: r.certificate,
    }, null, 2));
    return;
  }
  const lines = [];
  lines.push('== Logical Plan ==');
  lines.push(formatPlan(r.logical));
  lines.push('');
  lines.push('== Optimized Plan ==');
  lines.push(formatPlan(r.optimized));
  lines.push('');
  lines.push('== Rewrite Rules ==');
  if (r.certificate.rules.length === 0) lines.push('(none)');
  r.certificate.rules.forEach((x, i) => lines.push(`${i + 1}. ${x.rule}: ${x.detail}`));
  lines.push('');
  lines.push('== Physical Plans (min cost, all ties reported) ==');
  lines.push(`min cost = ${r.physical[0].cost}, ${r.physical.length} plan(s) tied:`);
  r.physical.forEach((p, i) => {
    lines.push(`-- plan ${i + 1} (cost ${p.cost}) --`);
    lines.push(formatPlan(p.plan));
  });
  lines.push('');
  lines.push('== Equivalence Certificate ==');
  lines.push(`mode: ${r.certificate.mode} (input rows: ${r.certificate.inputRows})`);
  lines.push(`baseline rows hash:  ${r.certificate.baseline.rowsHash}`);
  lines.push(`optimized rows hash: ${r.certificate.optimized.rowsHash}`);
  lines.push(`unknown groups: baseline=${r.certificate.baseline.unknownCount} optimized=${r.certificate.optimized.unknownCount}`);
  lines.push(`equal: ${r.certificate.equal}`);
  out.print(lines.join('\n'));
}

function cmdVerify(args, out) {
  const [fa, fb] = args._;
  if (!fa || !fb) throw new QError('E_PARSE', 'usage: verify <planA.sql|json> <planB.sql|json> [--data dir]');
  const data = loadTables(args.data || './data');
  const schemas = schemasFromData(data);
  const planA = loadPlanOrSql(fa, schemas);
  const planB = loadPlanOrSql(fb, schemas);
  const resA = execResult(toDirect(planA), data);
  const resB = execResult(toDirect(planB), data);
  if (!resultsEqual(resA, resB)) {
    throw E_NON_EQUIV(
      `plans are not equivalent on the given data: ` +
      `A=${JSON.stringify(summarizeResult(resA))} B=${JSON.stringify(summarizeResult(resB))}`
    );
  }
  out.print(JSON.stringify({
    verdict: 'EQUIV',
    a: summarizeResult(resA),
    b: summarizeResult(resB),
  }, null, 2));
}

function cmdBench(args, out) {
  const n = Number(args.rows);
  if (!Number.isInteger(n) || n <= 0) throw new QError('E_PARSE', 'usage: bench --rows N');
  const buckets = Math.max(1, Math.floor(n / 2));
  const a = [];
  const b = [];
  for (let i = 0; i < n; i++) {
    a.push({ id: i, k: i % buckets, v: i % 100 });
    b.push({ k: (i * 7) % buckets, w: i });
  }
  if (n >= 4) { a[1].k = null; b[2].k = null; } // exercise NULL join keys
  const data = { a, b };
  const cond = {
    t: 'bin', op: '=',
    l: { t: 'col', table: 'a', name: 'k', ref: 'a.k' },
    r: { t: 'col', table: 'b', name: 'k', ref: 'b.k' },
  };
  const scanA = { op: 'seqscan', table: 'a', alias: 'a', columns: ['id', 'k', 'v'] };
  const scanB = { op: 'seqscan', table: 'b', alias: 'b', columns: ['k', 'w'] };
  const ctx = () => ({ unknown: [], falseCount: 0 });

  let t0 = performance.now();
  const hashRows = execute({ op: 'hashjoin', cond, left: scanA, right: scanB }, data, ctx());
  const hashMs = performance.now() - t0;

  t0 = performance.now();
  const nestedRows = execute({ op: 'nljoin', cond, left: scanA, right: scanB }, data, ctx());
  const nestedMs = performance.now() - t0;

  if (hashRows.length !== nestedRows.length) {
    throw E_NON_EQUIV(`bench join mismatch: hash=${hashRows.length} nested=${nestedRows.length}`);
  }
  out.print(JSON.stringify({
    rows: n,
    matched: hashRows.length,
    hashJoinMs: Number(hashMs.toFixed(3)),
    nestedLoopMs: Number(nestedMs.toFixed(3)),
    speedup: nestedMs > 0 ? Number((nestedMs / Math.max(hashMs, 1e-9)).toFixed(2)) : null,
  }, null, 2));
}

const USAGE =
  'usage: cli.js <command>\n' +
  '  sql <file.sql> [--data dir]\n' +
  '  explain <file.sql> [--data dir] [--json]\n' +
  '  verify <planA.sql|json> <planB.sql|json> [--data dir]\n' +
  '  bench --rows N';

// Programmatic entry: returns {code, stdout, stderr} so it can be tested
// in-process (and embedded) without spawning.
function run(argv) {
  const stdout = [];
  const stderr = [];
  const out = {
    print: (s) => stdout.push(s + '\n'),
    warn: (s) => stderr.push(s + '\n'),
  };
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'sql': cmdSql(args, out); break;
      case 'explain': cmdExplain(args, out); break;
      case 'verify': cmdVerify(args, out); break;
      case 'bench': cmdBench(args, out); break;
      default:
        return { code: 2, stdout: '', stderr: USAGE };
    }
  } catch (err) {
    const code = err instanceof QError ? err.code : 'E_INTERNAL';
    stderr.push(JSON.stringify({ error: { code, message: err.message } }) + '\n');
    return { code: 1, stdout: stdout.join(''), stderr: stderr.join('') };
  }
  return { code: 0, stdout: stdout.join(''), stderr: stderr.join('') };
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}

module.exports = { run };
