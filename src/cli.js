import { writeFileSync, readFileSync } from 'node:fs';
import { settle } from './settle.js';
import { verifyCertificate } from './cert.js';
import { SettleError, E } from './errors.js';

function parseArgs(argv, fail) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) return fail(E.ARGS, `missing value for ${a}`);
      args[key] = val;
      i++;
    } else if (!args._cmd) {
      args._cmd = a;
    } else {
      return fail(E.ARGS, `unexpected argument ${a}`);
    }
  }
  return args;
}

// Runs the CLI. Returns the exit code; writes to stdout/stderr writers.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const fail = (code, message) => {
    io.stderr(JSON.stringify({ code, message }) + '\n');
    return 1;
  };
  try {
    const args = parseArgs(argv, fail);
    if (typeof args === 'number') return args; // parse failure already reported
    const cmd = args._cmd || 'settle';

    if (cmd === 'settle') {
      if (!args.in || !args.out || !args.cert) {
        return fail(E.ARGS, 'usage: settle --in <dir> --out <out.json> --cert <cert.json>');
      }
      const { out, cert } = settle(args.in);
      try {
        writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n');
        writeFileSync(args.cert, JSON.stringify(cert, null, 2) + '\n');
      } catch (err) {
        return fail(E.IO, `cannot write output: ${err.message}`);
      }
      io.stdout(JSON.stringify({ rows: out.rows.length, root: cert.root }) + '\n');
      return 0;
    }

    if (cmd === 'verify') {
      if (!args.cert) return fail(E.ARGS, 'usage: settle verify --cert <cert.json>');
      let cert;
      try {
        cert = JSON.parse(readFileSync(args.cert, 'utf8'));
      } catch (err) {
        return fail(E.PARSE, `cannot read certificate: ${err.message}`);
      }
      verifyCertificate(cert);
      io.stdout(JSON.stringify({ ok: true, rows: cert.row_count, root: cert.root }) + '\n');
      return 0;
    }

    return fail(E.ARGS, `unknown command ${cmd}`);
  } catch (err) {
    if (err instanceof SettleError) return fail(err.code, err.message);
    return fail('E_INTERNAL', err.message);
  }
}
