#!/usr/bin/env node
// NDJSON CLI: reads one command per line from stdin, writes one JSON result
// per line to stdout. State (keys, certs, revocation ledger) lives for the
// duration of the process.
import { CertStore, CertError } from './src/store.js';

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (data += chunk));
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

const store = new CertStore();

const handlers = {
  'issue-cert': (cmd) => ({ cert: store.issueCert(cmd) }),
  revoke: (cmd) => ({ revocation: store.revoke(cmd) }),
  restore: (cmd) => ({ restore: store.restore(cmd) }),
  'verify-payment': (cmd) => ({ authorization: store.verifyPayment(cmd) }),
};

for (const line of input.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let out;
  try {
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      throw new CertError('INVALID_JSON', `cannot parse line as JSON: ${trimmed}`);
    }
    const handler = handlers[cmd?.cmd];
    if (!handler) {
      throw new CertError('UNKNOWN_COMMAND', `unknown command: ${cmd?.cmd}`);
    }
    const { cmd: _ignored, ...rest } = cmd;
    out = { ok: true, ...handler(rest) };
  } catch (err) {
    if (err instanceof CertError) {
      out = { ok: false, error: { code: err.code, message: err.message } };
    } else {
      out = { ok: false, error: { code: 'INTERNAL', message: String(err?.message ?? err) } };
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
