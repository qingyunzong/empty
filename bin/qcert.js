#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { compileRule } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { parseSamples, aggregate, sampleSetHash } from '../src/samples.js';
import { issueCertificate, verifyCertificate } from '../src/cert.js';
import { SampleStore, Journal } from '../src/store.js';
import { QcertError } from '../src/errors.js';

// Exit codes (documented in README):
//   0  success (any decision incl. CONTINUE; certificate integrity OK)
//   1  certificate integrity / verification failure
//   2  input or usage error (lex/parse/type errors, bad samples, illegal rollback)
const EXIT_OK = 0;
const EXIT_VERIFY_FAIL = 1;
const EXIT_USAGE = 2;

// Synchronous writes: process.exit() would truncate async pipe buffers.
const out = (s) => writeSync(1, s);
const errOut = (s) => writeSync(2, s);

function fail(msg) {
  errOut(`error: ${msg}\n`);
  process.exit(EXIT_USAGE);
}

function report(err) {
  if (err instanceof QcertError) {
    const where = err.source ?? err.file ?? null;
    fail(err.format(where));
  }
  fail(err.message);
}

function parseArgs(argv, { flags = [], positionals = 0 }) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!flags.includes(name)) fail(`unknown option --${name}`);
      const value = argv[++i];
      if (value === undefined) fail(`option --${name} requires a value`);
      opts[name] = value;
    } else {
      pos.push(a);
    }
  }
  if (pos.length !== positionals) fail(`expected ${positionals} positional argument(s), got ${pos.length}`);
  return { opts, pos };
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read ${what} '${path}'`);
  }
}

function loadStore(path) {
  if (!existsSync(path)) return SampleStore.empty();
  let obj;
  try {
    obj = JSON.parse(readText(path, 'sample store'));
  } catch (err) {
    fail(`invalid sample store '${path}': ${err.message}`);
  }
  return new SampleStore(obj);
}

function loadJournal(path) {
  if (!existsSync(path)) return new Journal();
  return Journal.parse(readText(path, 'journal'), path);
}

const USAGE = `qcert - offline batch sampling QC with auditable certificates

usage:
  qcert decide <rule.dsl> <samples.jsonl> --cert <c.json> [--store <s.json>] [--journal <j.jsonl>]
  qcert verify <c.json> [--journal <j.jsonl>]
  qcert commit <samples.jsonl> [--store <s.json>]
  qcert draft <samples.jsonl> [--store <s.json>]
  qcert rollback [--store <s.json>]
  qcert compile <rule.dsl>

exit codes: 0 ok | 1 certificate verification failed | 2 input/usage error`;

function cmdDecide(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ['cert', 'store', 'journal'], positionals: 2 });
  const [rulePath, samplesPath] = pos;
  const certPath = opts.cert ?? fail('decide requires --cert <path>');
  const storePath = opts.store ?? `${samplesPath}.store.json`;
  const journalPath = opts.journal ?? 'qcert-journal.jsonl';

  const source = readText(rulePath, 'rule file');
  const program = compileRule(source);

  const samplesText = readText(samplesPath, 'samples file');
  const parsed = parseSamples(samplesText, samplesPath);
  const inputs = { ...aggregate(parsed), batch_id: parsed.batch.id };

  const store = loadStore(storePath);
  const { version } = store.commit(parsed);
  writeFileSync(storePath, JSON.stringify(store.data, null, 2) + '\n');

  const decision = run(program, inputs);
  const cert = issueCertificate({
    ruleSource: source,
    program,
    sampleVersion: version.version,
    sampleHash: version.hash,
    inputs,
    decision,
  });
  writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');

  const journal = loadJournal(journalPath);
  const record = journal.append({
    certHash: cert.cert_hash,
    ruleHash: cert.rule_hash,
    sampleVersion: cert.sample_version,
    sampleHash: cert.sample_hash,
    decision,
  });
  writeFileSync(journalPath, journal.serialize());

  out(
    `decision=${decision} sample_version=${version.version} cert=${cert.cert_hash}` +
    (record.supersedes.length ? ` superseded=${record.supersedes.length}` : '') +
    (decision === 'CONTINUE' ? ' (pending: keep sampling)' : '') + '\n',
  );
  process.exit(EXIT_OK);
}

function cmdVerify(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ['journal'], positionals: 1 });
  const [certPath] = pos;
  const journalPath = opts.journal ?? 'qcert-journal.jsonl';

  let cert;
  try {
    cert = JSON.parse(readText(certPath, 'certificate'));
  } catch (err) {
    fail(`invalid certificate JSON in '${certPath}': ${err.message}`);
  }
  const result = verifyCertificate(cert);
  if (!result.ok) {
    for (const e of result.errors) errOut(`invalid: ${e}\n`);
    process.exit(EXIT_VERIFY_FAIL);
  }
  const journal = loadJournal(journalPath);
  const status = journal.statusOf(result.certHash);
  out(`OK cert=${result.certHash} decision=${cert.decision} status=${status}\n`);
  process.exit(EXIT_OK);
}

function cmdCommit(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ['store'], positionals: 1 });
  const storePath = opts.store ?? `${pos[0]}.store.json`;
  const parsed = parseSamples(readText(pos[0], 'samples file'), pos[0]);
  const store = loadStore(storePath);
  const { version, created } = store.commit(parsed);
  writeFileSync(storePath, JSON.stringify(store.data, null, 2) + '\n');
  out(`committed version=${version.version} hash=${version.hash}${created ? '' : ' (unchanged)'}\n`);
  process.exit(EXIT_OK);
}

function cmdDraft(argv) {
  const { opts, pos } = parseArgs(argv, { flags: ['store'], positionals: 1 });
  const storePath = opts.store ?? `${pos[0]}.store.json`;
  const parsed = parseSamples(readText(pos[0], 'samples file'), pos[0]);
  const store = loadStore(storePath);
  const draft = store.beginDraft(parsed);
  writeFileSync(storePath, JSON.stringify(store.data, null, 2) + '\n');
  out(`staged draft based_on=${draft.based_on} hash=${draft.hash}\n`);
  process.exit(EXIT_OK);
}

function cmdRollback(argv) {
  const { opts } = parseArgs(argv, { flags: ['store'], positionals: 0 });
  const storePath = opts.store ?? fail('rollback requires --store <path>');
  const store = loadStore(storePath);
  const discarded = store.rollback();
  writeFileSync(storePath, JSON.stringify(store.data, null, 2) + '\n');
  out(`rolled back uncommitted draft based_on=${discarded.based_on}\n`);
  process.exit(EXIT_OK);
}

function cmdCompile(argv) {
  const { pos } = parseArgs(argv, { flags: [], positionals: 1 });
  const source = readText(pos[0], 'rule file');
  const program = compileRule(source);
  out(JSON.stringify(program, null, 2) + '\n');
  process.exit(EXIT_OK);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'decide': return cmdDecide(rest);
      case 'verify': return cmdVerify(rest);
      case 'commit': return cmdCommit(rest);
      case 'draft': return cmdDraft(rest);
      case 'rollback': return cmdRollback(rest);
      case 'compile': return cmdCompile(rest);
      case undefined:
      case 'help':
      case '--help':
        out(`${USAGE}\n`);
        return process.exit(cmd === undefined ? EXIT_USAGE : EXIT_OK);
      default:
        fail(`unknown command '${cmd}'\n${USAGE}`);
    }
  } catch (err) {
    report(err);
  }
}

main();
