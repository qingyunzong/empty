import { readFileSync, writeFileSync } from 'node:fs';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
import { VM } from './vm.js';
import { StlError, lexError, rtError } from './errors.js';
import { sha256Hex, stableStringify } from './hash.js';
import { parseMoney, dateToDays, money, dateVal, formatValue } from './money.js';
import { buildCert } from './cert.js';

const USAGE = `usage:
  settle run <rules.stl> <input.json> --cert <out.json>   run a settlement batch
  settle verify <rules.stl> <input.json> --cert <cert.json>  replay and verify a certificate
  settle hash <rules.stl>                                  print file and per-rule hashes
`;

const RULE_KINDS = ['fee', 'tax', 'net'];

function loadPipeline(rulesPath) {
  const src = readFileSync(rulesPath, 'utf8');
  const program = check(parse(tokenize(src)));
  const chunk = compile(program, src);
  return { src, program, chunk };
}

// input.rulesHash is either a whole-file sha256 string, or an object mapping
// rule/global names to their source hashes (for batches pinned to the exact
// rules they consume).
function verifyRulesHash(rulesHash, program, src) {
  if (rulesHash === undefined || rulesHash === null) {
    throw rtError("input is missing 'rulesHash'");
  }
  if (typeof rulesHash === 'string') {
    const actual = sha256Hex(src);
    if (actual !== rulesHash) {
      throw rtError(`rules hash mismatch: input declares ${rulesHash} but the rules file hashes to ${actual}`);
    }
    return;
  }
  if (typeof rulesHash === 'object') {
    for (const [name, hash] of Object.entries(rulesHash)) {
      const decl = program.decls.find(
        (d) => (d.type === 'ruleDecl' || d.type === 'paramDecl' || d.type === 'letDecl') && d.name === name,
      );
      if (!decl) throw rtError(`rules hash entry '${name}' matches no rule or global`);
      const actual = sha256Hex(src.slice(decl.start, decl.end));
      if (actual !== hash) {
        throw rtError(`rules hash mismatch for '${name}': input declares ${hash} but the source hashes to ${actual}`);
      }
    }
    return;
  }
  throw rtError("'rulesHash' must be a string (whole-file hash) or an object (per-rule hashes)");
}

function parseFlows(input) {
  if (!Array.isArray(input.flows)) throw rtError("input must contain a 'flows' array");
  return input.flows.map((flow, idx) => {
    const id = flow && flow.id;
    if (typeof id !== 'string' || id.length === 0) throw rtError(`flow #${idx} is missing a string 'id'`);
    if (typeof flow.amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(flow.amount)) {
      throw lexError(`invalid money amount '${flow.amount}' in flow '${id}' (max 2 decimals, no scientific notation)`);
    }
    if (typeof flow.date !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(flow.date)) {
      throw lexError(`invalid date '${flow.date}' in flow '${id}' (expected YYYY-MM-DD)`);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(flow.date);
    const days = dateToDays(Number(m[1]), Number(m[2]), Number(m[3]));
    if (days === null) throw lexError(`invalid date '${flow.date}' in flow '${id}'`);
    const plan = flow.plan === undefined ? null : flow.plan;
    if (plan !== null && (typeof plan !== 'string' || !/^[a-z0-9_]+$/.test(plan))) {
      throw rtError(`invalid plan '${flow.plan}' in flow '${id}'`);
    }
    return { id, amount: money(parseMoney(flow.amount)), day: dateVal(days), plan };
  });
}

function resolveRule(chunk, kind, plan) {
  if (plan && chunk.rules.some((r) => r.name === `${kind}_${plan}`)) return `${kind}_${plan}`;
  if (chunk.rules.some((r) => r.name === kind)) return kind;
  throw rtError(`rule not found: '${plan ? `${kind}_${plan}` : kind}'`);
}

function checkSignature(chunk, name) {
  const rule = chunk.rules.find((r) => r.name === name);
  const ok = rule.params.length === 2
    && rule.params[0].type === 'money'
    && rule.params[1].type === 'date'
    && rule.returnType === 'money';
  if (!ok) throw rtError(`rule '${name}' must have signature (amount: money, day: date) -> money`);
}

function runBatch(chunk, flows) {
  const trace = [];
  const usedGlobals = new Set();
  const vm = new VM(chunk, { trace, usedGlobals });
  vm.init();
  const results = [];
  for (const flow of flows) {
    const names = RULE_KINDS.map((kind) => resolveRule(chunk, kind, flow.plan));
    for (const name of names) checkSignature(chunk, name);
    const args = [flow.amount, flow.day];
    const [fee, tax, net] = names.map((name) => vm.callRule(name, args, flow.id));
    results.push({ id: flow.id, fee: formatValue(fee), tax: formatValue(tax), net: formatValue(net) });
  }
  const executedRules = [...new Set(trace.map((t) => t.rule))];
  return { results, trace, usedGlobals, executedRules };
}

function computeCert(rulesPath, inputPath) {
  const { src, program, chunk } = loadPipeline(rulesPath);
  const inputRaw = readFileSync(inputPath, 'utf8');
  let input;
  try {
    input = JSON.parse(inputRaw);
  } catch (err) {
    throw rtError(`invalid input JSON: ${err.message}`);
  }
  verifyRulesHash(input.rulesHash, program, src);
  const flows = parseFlows(input);
  const batch = runBatch(chunk, flows);
  return buildCert({ chunk, inputRaw, ...batch });
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      options[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, options };
}

function cmdRun(args) {
  const { positional, options } = parseArgs(args);
  const [rulesPath, inputPath] = positional;
  if (!rulesPath || !inputPath || !options.cert) throw rtError('run requires <rules.stl> <input.json> --cert <out.json>');
  const cert = computeCert(rulesPath, inputPath);
  writeFileSync(options.cert, stableStringify(cert, 2) + '\n');
  process.stdout.write(stableStringify({ results: cert.results, cert: options.cert }, 2) + '\n');
}

function cmdVerify(args) {
  const { positional, options } = parseArgs(args);
  const [rulesPath, inputPath] = positional;
  if (!rulesPath || !inputPath || !options.cert) throw rtError('verify requires <rules.stl> <input.json> --cert <cert.json>');
  const cert = computeCert(rulesPath, inputPath);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(options.cert, 'utf8'));
  } catch (err) {
    throw rtError(`cannot read certificate: ${err.message}`);
  }
  if (stableStringify(recorded) !== stableStringify(cert)) {
    const diffKeys = Object.keys(cert).filter(
      (k) => stableStringify(recorded[k]) !== stableStringify(cert[k]),
    );
    throw rtError(`certificate mismatch (differing fields: ${diffKeys.join(', ') || 'unknown'})`);
  }
  process.stdout.write(stableStringify({ ok: true, steps: cert.traceSummary.steps }, 2) + '\n');
}

function cmdHash(args) {
  const { positional } = parseArgs(args);
  const [rulesPath] = positional;
  if (!rulesPath) throw rtError('hash requires <rules.stl>');
  const { src, chunk } = loadPipeline(rulesPath);
  const out = { file: sha256Hex(src), rules: {}, globals: {} };
  for (const rule of chunk.rules) out.rules[rule.name] = rule.hash;
  for (const global of chunk.globals) out.globals[global.name] = global.hash;
  process.stdout.write(stableStringify(out, 2) + '\n');
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'run') cmdRun(rest);
    else if (cmd === 'verify') cmdVerify(rest);
    else if (cmd === 'hash') cmdHash(rest);
    else {
      process.stderr.write(USAGE);
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof StlError) {
      process.stderr.write(JSON.stringify(err.toJSON()) + '\n');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
