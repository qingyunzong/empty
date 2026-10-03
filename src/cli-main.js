import fs from 'node:fs';
import path from 'node:path';
import { parseSql } from './parser.js';
import { buildLogicalPlan } from './plan.js';
import { optimize } from './optimizer.js';
import { enumeratePhysical, bestPlans } from './physical.js';
import { execLogical, execPhysical } from './exec.js';
import { buildCertificate } from './cert.js';
import { verifyPlans, validateCertificateRules, validatePlanShape } from './verify.js';
import { bench } from './bench.js';
import { LakeError, E_PARSE, E_TYPE } from './errors.js';

const USAGE = `lakeq — single-node query optimizer playground

usage:
  lakeq sql <file.sql> [--data DIR]        run a query, print rows + unknown rows + certificate
  lakeq explain <file.sql> [--data DIR] [--stage logical|optimized] [--out plan.json]
                                           print plans, costs, rewrite rules, certificate
  lakeq verify <planA> <planB> [--data DIR]
                                           prove two plans equivalent (.sql or .json plans)
  lakeq bench --rows N                     synthetic benchmark, direct vs optimized

errors: E_PARSE, E_TYPE, E_NON_EQUIV, E_UNSUPPORTED (exit code 1, JSON on stderr)`;

function parseFlags(args) {
  const flags = { data: 'data', stage: 'optimized', out: null, rows: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--data') flags.data = args[++i];
    else if (a === '--stage') flags.stage = args[++i];
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--rows') flags.rows = Number(args[++i]);
    else if (a.startsWith('--')) throw new LakeError(E_PARSE, `unknown flag ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

function validateRows(name, rows) {
  if (!Array.isArray(rows)) throw new LakeError(E_TYPE, `table ${name}: JSON file must contain an array of row objects`);
  for (const [i, r] of rows.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new LakeError(E_TYPE, `table ${name}: row ${i} is not an object`);
    for (const [k, v] of Object.entries(r)) {
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
        throw new LakeError(E_TYPE, `table ${name}: row ${i} column ${k} has unsupported type ${typeof v}`);
      }
    }
  }
}

function loadTables(names, dataDir) {
  const tables = {};
  for (const name of names) {
    if (tables[name]) continue;
    const file = path.join(dataDir, `${name}.json`);
    if (!fs.existsSync(file)) throw new LakeError(E_TYPE, `table not found: ${name} (expected ${file})`);
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new LakeError(E_PARSE, `table ${name}: invalid JSON in ${file}: ${e.message}`);
    }
    validateRows(name, rows);
    const columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    tables[name] = { columns, rows };
  }
  return tables;
}

const catalogOf = (tables) => Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { columns: v.columns }]));

function tableNamesOfAst(ast) {
  return [ast.from.table.name, ...ast.from.joins.map((j) => j.table.name)];
}

function tableNamesOfPlan(node, into = new Set()) {
  if (node.type === 'scan') into.add(node.table);
  if (node.input) tableNamesOfPlan(node.input, into);
  if (node.left) tableNamesOfPlan(node.left, into);
  if (node.right) tableNamesOfPlan(node.right, into);
  return [...into];
}

function compileQuery(sqlFile, dataDir) {
  const sqlText = fs.readFileSync(sqlFile, 'utf8');
  const ast = parseSql(sqlText);
  const tables = loadTables(tableNamesOfAst(ast), dataDir);
  const logical = buildLogicalPlan(ast, catalogOf(tables));
  const { plan: optimized, rules } = optimize(logical);
  return { ast, tables, logical, optimized, rules };
}

function cmdSql(file, flags) {
  const { tables, logical, optimized, rules } = compileQuery(file, flags.data);
  const ctx = { tables };
  const alts = enumeratePhysical(optimized, ctx);
  const best = bestPlans(alts);
  const result = execPhysical(best[0].node, ctx);
  const direct = execLogical(logical, ctx);
  const certificate = buildCertificate({ rules, tables, direct, optimized: result });
  return {
    rows: result.rows,
    unknown: result.unknown,
    rowCount: result.rows.length,
    unknownCount: result.unknown.length,
    cost: best[0].cost,
    tiedBestPlans: best.length,
    certificate,
  };
}

function cmdExplain(file, flags) {
  const { tables, logical, optimized, rules } = compileQuery(file, flags.data);
  const ctx = { tables };
  const alts = enumeratePhysical(optimized, ctx);
  const best = bestPlans(alts);
  const bestSet = new Set(best);
  const direct = execLogical(logical, ctx);
  const optResult = execPhysical(best[0].node, ctx);
  const certificate = buildCertificate({ rules, tables, direct, optimized: optResult });
  const out = {
    logicalPlan: logical,
    optimizedPlan: optimized,
    rewriteRules: rules,
    physicalPlans: alts.map((a) => ({ cost: a.cost, chosen: bestSet.has(a), plan: a.node })),
    tiedBestPlans: best.length,
    certificate,
  };
  if (flags.out) {
    const plan = flags.stage === 'logical' ? logical : optimized;
    const payload = { format: 'lakeq-plan@1', stage: flags.stage, plan, certificate: { rules } };
    fs.writeFileSync(flags.out, JSON.stringify(payload, null, 2));
    out.written = flags.out;
    out.stage = flags.stage;
  }
  return out;
}

function loadPlanSpec(file, dataDir) {
  if (file.endsWith('.sql')) {
    const sqlText = fs.readFileSync(file, 'utf8');
    const ast = parseSql(sqlText);
    const tables = loadTables(tableNamesOfAst(ast), dataDir);
    return { plan: buildLogicalPlan(ast, catalogOf(tables)), tables, certificate: null };
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new LakeError(E_PARSE, `invalid plan JSON in ${file}: ${e.message}`);
  }
  if (!payload || payload.format !== 'lakeq-plan@1' || !payload.plan) {
    throw new LakeError(E_PARSE, `${file}: not a lakeq plan file (expected {format:"lakeq-plan@1", plan})`);
  }
  validatePlanShape(payload.plan);
  const tables = loadTables(tableNamesOfPlan(payload.plan), dataDir);
  return { plan: payload.plan, tables, certificate: payload.certificate ?? null };
}

function cmdVerify(fileA, fileB, flags) {
  const a = loadPlanSpec(fileA, flags.data);
  const b = loadPlanSpec(fileB, flags.data);
  if (a.certificate?.rules) validateCertificateRules(a.certificate.rules);
  if (b.certificate?.rules) validateCertificateRules(b.certificate.rules);
  const tables = { ...a.tables, ...b.tables };
  return verifyPlans(a.plan, b.plan, { tables });
}

export function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    return { code: cmd ? 0 : 2, stdout: USAGE + '\n', stderr: '' };
  }
  const { flags, positional } = parseFlags(rest);
  let out;
  switch (cmd) {
    case 'sql':
      if (positional.length !== 1) throw new LakeError(E_PARSE, 'sql requires exactly one <file.sql>');
      out = cmdSql(positional[0], flags);
      break;
    case 'explain':
      if (positional.length !== 1) throw new LakeError(E_PARSE, 'explain requires exactly one <file.sql>');
      if (!['logical', 'optimized'].includes(flags.stage)) throw new LakeError(E_PARSE, '--stage must be logical|optimized');
      out = cmdExplain(positional[0], flags);
      break;
    case 'verify':
      if (positional.length !== 2) throw new LakeError(E_PARSE, 'verify requires <planA> <planB>');
      out = cmdVerify(positional[0], positional[1], flags);
      break;
    case 'bench':
      if (!Number.isInteger(flags.rows) || flags.rows < 0) throw new LakeError(E_PARSE, 'bench requires --rows N (non-negative integer)');
      out = bench(flags.rows);
      break;
    default:
      throw new LakeError(E_PARSE, `unknown command '${cmd}'\n${USAGE}`);
  }
  return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
}

export function runCliSafe(argv) {
  try {
    return runCli(argv);
  } catch (e) {
    if (e instanceof LakeError) {
      return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code: e.code, message: e.message } }) + '\n' };
    }
    throw e;
  }
}
