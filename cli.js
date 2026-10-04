#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { certify } from './lib/certify.js';
import { verifyOutDir } from './lib/verify.js';
import { CertError, EXIT_INPUT_ERROR } from './lib/errors.js';

function cmdCertify(args) {
  const { values } = parseArgs({
    args,
    options: { in: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.in || !values.out) {
    console.error('usage: node cli.js certify --in <input-dir> --out <output-dir>');
    return 1;
  }
  try {
    const summary = certify({ inDir: values.in, outDir: values.out });
    for (const cert of summary.certs) {
      const note = cert.reused ? 'unchanged' : cert.revoked_previous ? 'issued, previous revoked' : 'issued';
      console.log(
        `${cert.batch_id}: ${cert.status} seq=${cert.seq} hash=${cert.hash.slice(0, 16)}… (${note})`,
      );
    }
    console.log(`index: ${summary.indexPath}`);
    return 0;
  } catch (err) {
    if (err instanceof CertError) {
      console.error(`error[${err.code}]: ${err.message}`);
      return EXIT_INPUT_ERROR;
    }
    console.error(`error: ${err.message}`);
    return 1;
  }
}

function cmdVerify(args) {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node cli.js verify --out <output-dir>');
    return 1;
  }
  const result = verifyOutDir(values.out);
  if (result.ok) {
    console.log('chain OK');
    return 0;
  }
  for (const err of result.errors) console.error(`verify failed: ${err}`);
  return 1;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'certify') return cmdCertify(rest);
  if (cmd === 'verify') return cmdVerify(rest);
  console.error('usage: node cli.js <certify|verify> [--in dir] [--out dir]');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
