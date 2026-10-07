#!/usr/bin/env node
// Usage:
//   node src/cli.js settle <events.jsonl> [--base CCC] [--decimals N] [--cert-out FILE]
//   node src/cli.js verify <events.jsonl> <certificate.json>
//   node src/cli.js hash   <events.jsonl>
//
// Exit codes: 0 ok / infeasible-with-certificate / valid,
//             1 verification failed, 2 E_PARSE, 3 E_PENDING, 4 E_REF.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadLog, CodedError } from './eventlog.js';
import { settle } from './settle.js';
import { verifyCertificate } from './verify.js';

export const EXIT = { E_PARSE: 2, E_PENDING: 3, E_REF: 4, E_INTERNAL: 70 };

const USAGE =
  'commands: settle <file.jsonl> [--base CCC] [--decimals N] [--cert-out FILE]\n' +
  '          verify <file.jsonl> <certificate.json>\n' +
  '          hash   <file.jsonl>\n';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      opts[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

// Runs the CLI in-process; returns { code, stdout, stderr }.
export function runCli(argv, { certSink } = {}) {
  try {
    const [cmd, ...rest] = argv;
    const { positional, opts } = parseArgs(rest);

    if (!cmd || cmd === 'help' || cmd === '--help') return { code: 0, stdout: USAGE, stderr: '' };

    const file = positional[0];
    if (!file) throw new CodedError('E_PARSE', 'missing JSONL file argument');
    const log = loadLog(readFileSync(file, 'utf8'));

    if (cmd === 'settle') {
      const decimals = opts.decimals !== undefined ? Number(opts.decimals) : 2;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
        throw new CodedError('E_PARSE', '--decimals must be an integer in [0,18]');
      const result = settle(log, { base: opts.base, decimals });
      if (opts['cert-out'] && result.certificate) {
        const text = JSON.stringify(result.certificate, null, 2) + '\n';
        if (certSink) certSink(opts['cert-out'], text);
        else writeFileSync(opts['cert-out'], text);
      }
      return {
        code: result.status === 'pending' ? EXIT.E_PENDING : 0,
        stdout: JSON.stringify(result, null, 2) + '\n',
        stderr: '',
      };
    }

    if (cmd === 'verify') {
      const certFile = positional[1];
      if (!certFile) throw new CodedError('E_PARSE', 'missing certificate file argument');
      let cert;
      try {
        cert = JSON.parse(readFileSync(certFile, 'utf8'));
      } catch (e) {
        throw new CodedError('E_PARSE', `certificate file: ${e.message}`);
      }
      if (cert && cert.certificate) cert = cert.certificate; // accept full settle output too
      const result = verifyCertificate(log, cert);
      return { code: result.valid ? 0 : 1, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
    }

    if (cmd === 'hash') {
      const lines = log.hashTrail.map((h, i) => `evt:${i + 1} ${h}`);
      lines.push(`head ${log.head}`);
      return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
    }

    throw new CodedError('E_PARSE', `unknown command "${cmd}"`);
  } catch (err) {
    if (err instanceof CodedError) {
      const out = { error: { code: err.code, message: err.message } };
      if (err.line) out.error.line = err.line;
      return { code: EXIT[err.code] ?? EXIT.E_INTERNAL, stdout: '', stderr: JSON.stringify(out) + '\n' };
    }
    return {
      code: EXIT.E_INTERNAL,
      stdout: '',
      stderr: JSON.stringify({ error: { code: 'E_INTERNAL', message: err.message } }) + '\n',
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
