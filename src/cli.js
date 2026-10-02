import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DslError, InputError } from './errors.js';
import { decide } from './engine.js';
import { verifyChain, rollback } from './ledger.js';

const USAGE = [
  'usage:',
  '  qcert decide <rule.dsl> <samples.jsonl> --cert <chain.json> [--draft]',
  '  qcert verify <chain.json>',
  '  qcert rollback <chain.json> --to <version>',
  '',
  'exit codes:',
  '  0  success',
  '  1  verification failed (certificate or chain integrity)',
  '  2  input or usage error (parse/type errors carry file and line number)',
  '',
].join('\n');

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new InputError(`cannot read file '${path}'`);
  }
}

function readChain(path) {
  let parsed;
  try {
    parsed = JSON.parse(readText(path));
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError(`'${path}' is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.format !== 'qcert-chain/1' || !Array.isArray(parsed.certs)) {
    throw new InputError(`'${path}' is not a qcert-chain/1 certificate chain`);
  }
  return parsed;
}

function parseFlags(args, allowed) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!allowed.has(arg)) throw new InputError(`unknown flag '${arg}'`);
      if (arg === '--draft') {
        flags.set(arg, true);
      } else {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new InputError(`flag '${arg}' requires a value`);
        }
        flags.set(arg, value);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function cmdDecide(args, io) {
  const { positional, flags } = parseFlags(args, new Set(['--cert', '--draft']));
  if (positional.length !== 2 || !flags.has('--cert')) {
    throw new InputError('decide requires <rule.dsl> <samples.jsonl> --cert <chain.json>');
  }
  const [rulePath, samplesPath] = positional;
  const certPath = flags.get('--cert');

  const chain = existsSync(certPath) ? readChain(certPath) : null;
  const { chain: updated, issued } = decide({
    ruleSource: readText(rulePath),
    ruleFilename: rulePath,
    samplesText: readText(samplesPath),
    samplesFilename: samplesPath,
    chain,
    draft: flags.has('--draft'),
  });

  writeFileSync(certPath, `${JSON.stringify(updated, null, 2)}\n`);

  if (issued.length === 0) {
    io.out('no new versions; certificate chain unchanged');
  }
  for (const cert of issued) {
    io.out(
      `v${cert.version} ${cert.decision} (${cert.status}) ` +
      `cert=${cert.certHash.slice(0, 16)}... samples=${cert.sampleHash.slice(0, 16)}...`,
    );
  }
  const latest = updated.certs[updated.certs.length - 1];
  io.out(`certificates: ${updated.certs.length}, latest: v${latest.version} ${latest.decision} (${latest.status})`);
  return 0;
}

function cmdVerify(args, io) {
  const { positional } = parseFlags(args, new Set());
  if (positional.length !== 1) {
    throw new InputError('verify requires <chain.json>');
  }
  const chain = readChain(positional[0]);
  const { ok, results, errors } = verifyChain(chain);

  for (const result of results) {
    const mark = result.ok ? 'ok' : `INVALID (${result.problems.join(', ')})`;
    io.out(`v${result.version} ${result.decision} ${result.status} ${mark}`);
  }
  if (!ok) {
    for (const error of errors) io.err(`error: ${error}`);
    io.err(`FAILED: ${results.length} certificate(s), chain integrity broken`);
    return 1;
  }
  const latest = results[results.length - 1];
  io.out(
    `OK: ${results.length} certificate(s) verified` +
    (latest ? `, latest: v${latest.version} ${latest.decision} (${latest.status})` : ''),
  );
  return 0;
}

function cmdRollback(args, io) {
  const { positional, flags } = parseFlags(args, new Set(['--to']));
  if (positional.length !== 1 || !flags.has('--to')) {
    throw new InputError('rollback requires <chain.json> --to <version>');
  }
  const target = Number(flags.get('--to'));
  const chain = readChain(positional[0]);
  const dropped = rollback(chain, target);
  writeFileSync(positional[0], `${JSON.stringify(chain, null, 2)}\n`);
  io.out(`rolled back to version ${target}; discarded ${dropped} draft certificate(s)`);
  return 0;
}

// Executes one CLI invocation and returns the exit code. `io` carries the
// output sinks so tests can capture them without spawning a process.
export function execute(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [command, ...rest] = argv;
  try {
    let code;
    if (command === 'decide') code = cmdDecide(rest, io);
    else if (command === 'verify') code = cmdVerify(rest, io);
    else if (command === 'rollback') code = cmdRollback(rest, io);
    else {
      io.err(USAGE);
      code = command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
    return code;
  } catch (err) {
    io.err(`error: ${err.message}`);
    return 2;
  }
}

export function main(argv) {
  process.exitCode = execute(argv);
}
