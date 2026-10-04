'use strict';

const fs = require('fs');
const { lex } = require('./lexer');
const { parse } = require('./parser');
const { check } = require('./types');
const { compile } = require('./compiler');
const { VM, fmtMoney, parseMoney, parseDate } = require('./vm');
const { sha256, stableStringify } = require('./hash');
const { DslError } = require('./errors');

function loadAndCompile(rulesPath) {
  const src = fs.readFileSync(rulesPath, 'utf8');
  const prog = check(parse(lex(src)));
  const compiled = compile(prog);
  return { src, compiled };
}

function buildCertificate(rulesPath, inputPath) {
  const { src, compiled } = loadAndCompile(rulesPath);
  const rulesHash = sha256(src);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    throw new DslError('E_RT', `invalid input JSON: ${e.message}`, 0, 0);
  }
  const inputHash = sha256(stableStringify(input));
  if (input.rules_hash !== undefined && input.rules_hash !== rulesHash) {
    throw new DslError('E_RT',
      `rules hash mismatch: input expects ${input.rules_hash} but file hashes to ${rulesHash}`, 0, 0);
  }
  if (!Array.isArray(input.flows)) {
    throw new DslError('E_RT', 'input must contain a "flows" array', 0, 0);
  }

  const idx = {};
  compiled.rules.forEach((r, i) => { idx[r.name] = i; });
  for (const name of ['fee', 'tax', 'net']) {
    if (idx[name] === undefined) {
      throw new DslError('E_RT', `rules must define a '${name}' rule`, 0, 0);
    }
  }

  const trace = [];
  const vm = new VM(compiled, trace);
  const results = input.flows.map((flow, i) => {
    const ctx = `flow #${i} (${flow && flow.id !== undefined ? flow.id : 'no id'})`;
    if (flow === null || typeof flow !== 'object' || typeof flow.id !== 'string') {
      throw new DslError('E_RT', `flow #${i} must be an object with a string "id"`, 0, 0);
    }
    const amount = { t: 'money', v: parseMoney(flow.amount, ctx) };
    const day = { t: 'date', v: parseDate(flow.date, ctx) };
    const fee = vm.callRule(idx.fee, [amount, day]);
    const tax = vm.callRule(idx.tax, [amount, day]);
    const net = vm.callRule(idx.net, [amount, day]);
    return { id: flow.id, fee: fmtMoney(fee.v), tax: fmtMoney(tax.v), net: fmtMoney(net.v) };
  });

  const ruleHashes = {};
  compiled.rules.forEach((r) => { ruleHashes[r.name] = sha256(stableStringify(r)); });

  return {
    version: 1,
    rules_hash: rulesHash,
    input_hash: inputHash,
    bytecode_hash: sha256(stableStringify(compiled)),
    rule_hashes: ruleHashes,
    trace: { instructions: trace.length, digest: sha256(trace.join('\n')) },
    results,
  };
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage() {
  process.stderr.write(
    'usage:\n' +
    '  settle run <rules.stl> <input.json> --cert <out.json>\n' +
    '  settle verify <rules.stl> <input.json> --cert <out.json>\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'run' || cmd === 'verify') {
      const positional = rest.filter((a, i) => a !== '--cert' && (i === 0 || rest[i - 1] !== '--cert'));
      const [rulesPath, inputPath] = positional;
      const certPath = flagValue(rest, '--cert');
      if (!rulesPath || !inputPath || !certPath) {
        usage();
        return 2;
      }
      const cert = buildCertificate(rulesPath, inputPath);
      if (cmd === 'run') {
        fs.writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
        process.stdout.write(JSON.stringify({ ok: true, flows: cert.results.length, cert: certPath }) + '\n');
        return 0;
      }
      const existing = JSON.parse(fs.readFileSync(certPath, 'utf8'));
      if (stableStringify(existing) === stableStringify(cert)) {
        process.stdout.write(JSON.stringify({ ok: true, flows: cert.results.length }) + '\n');
        return 0;
      }
      process.stdout.write(JSON.stringify({ ok: false, message: 'certificate does not match recomputation' }) + '\n');
      return 1;
    }
    usage();
    return 2;
  } catch (e) {
    if (e instanceof DslError) {
      process.stderr.write(JSON.stringify(e.toJSON()) + '\n');
      return 1;
    }
    process.stderr.write(JSON.stringify({ code: 'E_RT', message: String((e && e.message) || e), line: 0, col: 0 }) + '\n');
    return 1;
  }
}

module.exports = { main, buildCertificate };
