'use strict';

const fs = require('fs');
const { parseLog, verifyEvents, serializeLog } = require('./chain');
const { validateOps, applyOps, buildCert, persistPatch } = require('./patch');
const { checkLogs } = require('./check');
const { recoverState } = require('./recover');
const { AuditError } = require('./errors');

const USAGE = `usage:
  audit verify <log.jsonl>
  audit patch <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>
  audit check <old.jsonl> <new.jsonl> <cert.json>
  audit recover --out <new.jsonl> --cert <cert.json>

exit codes:
  0  success
  1  usage / invalid input
  2  recover: mixed state, manual rollback required
  9  broken hash chain
  10 unauthorized seq/prevHash modification
  11 certificate does not match files`;

function parseFlags(args, allowed) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (!allowed.has(key) || i + 1 >= args.length) {
        throw new AuditError(`bad or missing value for flag --${key}`, 1);
      }
      flags[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new AuditError(`cannot read ${path}: ${err.message}`, 1);
  }
}

function loadVerifiedLog(path) {
  const events = parseLog(readFile(path));
  const root = verifyEvents(events);
  return { events, root };
}

function cmdVerify(args) {
  const { positional } = parseFlags(args, new Set());
  if (positional.length !== 1) throw new AuditError('verify expects exactly one log file', 1);
  const { events, root } = loadVerifiedLog(positional[0]);
  process.stdout.write(`OK events=${events.length} root=${root}\n`);
}

function cmdPatch(args) {
  const { positional, flags } = parseFlags(args, new Set(['out', 'cert']));
  if (positional.length !== 2 || !flags.out || !flags.cert) {
    throw new AuditError('patch expects <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>', 1);
  }
  const { events, root } = loadVerifiedLog(positional[0]);
  let fix;
  try {
    fix = JSON.parse(readFile(positional[1]));
  } catch (err) {
    if (err instanceof AuditError) throw err;
    throw new AuditError(`invalid fix.json: ${err.message}`, 1);
  }
  if (typeof fix !== 'object' || fix === null || !('patchOps' in fix)) {
    throw new AuditError('fix.json must be an object with a "patchOps" array', 1);
  }
  const ops = fix.patchOps;
  validateOps(ops);
  const result = applyOps(events, ops);
  const cert = buildCert(events, root, result);
  persistPatch(flags.out, serializeLog(result.newEvents), flags.cert, JSON.stringify(cert, null, 2) + '\n');
  process.stdout.write(
    `OK patched=${result.changedSeqs.length} changedSeqs=[${result.changedSeqs.join(',')}] ` +
      `oldRoot=${cert.oldRoot} newRoot=${cert.newRoot}\n`
  );
}

function cmdCheck(args) {
  const { positional } = parseFlags(args, new Set());
  if (positional.length !== 3) throw new AuditError('check expects <old.jsonl> <new.jsonl> <cert.json>', 1);
  const oldLog = loadVerifiedLog(positional[0]);
  const newLog = loadVerifiedLog(positional[1]);
  let cert;
  try {
    cert = JSON.parse(readFile(positional[2]));
  } catch (err) {
    if (err instanceof AuditError) throw err;
    throw new AuditError(`invalid cert JSON: ${err.message}`, 11);
  }
  const { changedSeqs } = checkLogs(oldLog.events, newLog.events, cert);
  process.stdout.write(
    `OK changedSeqs=[${changedSeqs.join(',')}] oldRoot=${oldLog.root} newRoot=${newLog.root}\n`
  );
}

function cmdRecover(args) {
  const { positional, flags } = parseFlags(args, new Set(['out', 'cert']));
  if (positional.length !== 0 || !flags.out || !flags.cert) {
    throw new AuditError('recover expects --out <new.jsonl> --cert <cert.json>', 1);
  }
  const { state, reason, tmps } = recoverState(flags.out, flags.cert);
  if (state === 'OLD') {
    process.stdout.write('OLD: no committed outputs; the old log is authoritative.\n');
    if (tmps.length) {
      process.stdout.write(`rollback: remove leftover temp files: ${tmps.join(' ')}\n`);
    }
    return;
  }
  if (state === 'NEW') {
    process.stdout.write('NEW: patch committed; run "audit check" to confirm old/new/cert consistency.\n');
    if (tmps.length) {
      process.stdout.write(`cleanup: remove leftover temp files: ${tmps.join(' ')}\n`);
    }
    return;
  }
  process.stderr.write(`MIXED: ${reason}\n`);
  process.stderr.write(
    `ROLLBACK required: delete partial outputs (${[flags.out, flags.cert, ...tmps]
      .filter((p) => fs.existsSync(p))
      .join(' ')}) to return to the old version, then re-run patch. Files are never silently mixed.\n`
  );
  process.exitCode = 2;
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'verify':
        return cmdVerify(rest);
      case 'patch':
        return cmdPatch(rest);
      case 'check':
        return cmdCheck(rest);
      case 'recover':
        return cmdRecover(rest);
      default:
        process.stderr.write(USAGE + '\n');
        process.exitCode = command === undefined || command === 'help' || command === '--help' ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof AuditError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else {
      process.stderr.write(`internal error: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { main };
