#!/usr/bin/env node
'use strict';

const { loadInputs, evaluateAll } = require('./lib/core');
const { certify, verifyChain, verifyCert } = require('./lib/certs');
const { CertError } = require('./lib/util');

const USAGE = `usage:
  node cli.js certify --in <dir> --out <certsDir>
  node cli.js verify --certs <certsDir> [--cert <file>]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new CertError(`missing value for --${key}`);
      args[key] = value;
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// Runs the CLI in-process. Returns the exit code; errors are reported through
// the injected logger so tests can capture output without spawning processes.
function run(argv, logger = console) {
  try {
    const args = parseArgs(argv);
    const command = args._[0];

    if (command === 'certify') {
      if (!args.in || !args.out) throw new CertError('certify requires --in <dir> and --out <certsDir>');
      const inputs = loadInputs(args.in);
      const evaluations = evaluateAll(inputs);
      const summary = certify(evaluations, args.out);
      for (const item of summary) {
        logger.log(`${item.status}\t${item.batch_id}\t${item.hash}`);
      }
      return 0;
    }

    if (command === 'verify') {
      if (!args.certs) throw new CertError('verify requires --certs <certsDir>');
      if (args.cert) {
        const result = verifyCert(args.certs, args.cert);
        logger.log(JSON.stringify(result));
        return result.usable ? 0 : 1;
      }
      const report = verifyChain(args.certs);
      logger.log(JSON.stringify(report, null, 2));
      return report.valid ? 0 : 1;
    }

    throw new CertError(USAGE);
  } catch (err) {
    if (err instanceof CertError) {
      logger.error(`error: ${err.message}`);
      return err.exitCode;
    }
    logger.error(err.stack || String(err));
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, USAGE };
