#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PackStore } from './store.js';
import { evaluateClaim } from './verify.js';
import { issueCert, checkCert } from './cert.js';
import { EvpackError } from './errors.js';

const EXIT_CODES = {
  E_DUP_RULE: 2,
  E_EVIDENCE_GONE: 3,
  E_UNDECIDED: 4,
  E_CERT_MISMATCH: 5,
};

const USAGE = `evpack - offline regulatory evidence pack validator

Usage:
  evpack load <dir>                      (Re)load evidence from <dir> (evidence.jsonl, evidence/*.json)
  evpack rule add <json|@file> [--dir D] Add an exclusion rule {"id","priority","where":[...]}
  evpack rule list [--dir D]             List rules
  evpack retract <evidenceKey> [--dir D] Retract one evidence row (incremental, no full rescan)
  evpack verify <claim|@file> [--dir D]  Evaluate a claim, print three-valued conclusion
  evpack cert <claim|@file> [--dir D] [--out f]   Issue a reviewable certificate
  evpack cert --check <certFile> [--dir D]        Verify a certificate (tamper/staleness detection)

Claim: {"where":[{"field","op","value"}], "aggregate":{"op":"count|sum|min|max","field":"*"},
        "expect":{"op":"lt|lte|gt|gte","value":N}}
Predicate ops: eq ne lt lte gt gte in exists. Default --dir: $EVPACK_DIR or ".".
Exit codes: 0 ok, 1 invalid, 2 E_DUP_RULE, 3 E_EVIDENCE_GONE, 4 E_UNDECIDED, 5 E_CERT_MISMATCH.`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

function readJsonArg(s) {
  if (s.startsWith('@')) return JSON.parse(fs.readFileSync(s.slice(1), 'utf8'));
  if (s.endsWith('.json') && fs.existsSync(s)) return JSON.parse(fs.readFileSync(s, 'utf8'));
  return JSON.parse(s);
}

// Runs one CLI invocation in-process. Returns { code, stdout, stderr } so the
// logic is testable without spawning a child process.
export function runCli(argv, env = process.env) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  const print = (v) => { stdout += JSON.stringify(v, null, 2) + '\n'; };
  try {
    const extra = dispatch(argv, env, print);
    if (extra) stdout += extra;
  } catch (err) {
    if (err instanceof EvpackError) {
      stderr = `${err.code}: ${err.message}\n`;
      code = EXIT_CODES[err.code] ?? 1;
    } else {
      stderr = `E_INVALID: ${err.message}\n`;
      code = 1;
    }
  }
  return { code, stdout, stderr };
}

function dispatch(argv, env, print) {
  const { pos, opts } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  const dir = opts.dir ?? env.EVPACK_DIR ?? '.';

  switch (cmd) {
    case 'load': {
      const target = sub;
      if (!target) throw new EvpackError('E_INVALID', 'load requires a <dir>');
      const store = PackStore.loadDir(target);
      store.save();
      print({
        ok: true, dir: target, evidence: store.evidence.size,
        rules: store.rules.length, ruleVersion: store.ruleVersion, inputHash: store.inputHash(),
      });
      return;
    }
    case 'rule': {
      const store = PackStore.open(dir);
      if (sub === 'add') {
        const rule = store.addRule(readJsonArg(rest[0]));
        store.save();
        print({ ok: true, rule, ruleVersion: store.ruleVersion });
      } else if (sub === 'list') {
        print({ rules: store.rules, ruleVersion: store.ruleVersion });
      } else {
        throw new EvpackError('E_INVALID', "usage: rule add <json> | rule list");
      }
      return;
    }
    case 'retract': {
      if (!sub) throw new EvpackError('E_INVALID', 'retract requires an <evidenceKey>');
      const store = PackStore.open(dir);
      const r = store.retract(sub);
      store.save();
      print({ ok: true, ...r, inputHash: store.inputHash() });
      return;
    }
    case 'verify': {
      const store = PackStore.open(dir);
      print(evaluateClaim(store, readJsonArg(sub)));
      return;
    }
    case 'cert': {
      const store = PackStore.open(dir);
      if (opts.check) {
        const cert = JSON.parse(fs.readFileSync(opts.check, 'utf8'));
        print(checkCert(store, cert));
      } else {
        const cert = issueCert(store, readJsonArg(sub));
        if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(cert, null, 2) + '\n');
        print(cert);
      }
      return;
    }
    default:
      if (cmd) throw new EvpackError('E_INVALID', `unknown command: ${cmd}`);
      return USAGE + '\n';
  }
  return '';
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
