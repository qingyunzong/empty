import { readFileSync, writeFileSync } from 'node:fs';
import { Ledger, LedgerError } from './core.js';
import { appendEvent, loadEvents } from './store.js';

const MUTATING = {
  create: 'createBatch',
  correct: 'applyCorrection',
  confirm: 'confirmBatch',
  revoke: 'revokeBatch',
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, input: null, output: null, state: 'settle.jsonl' };
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--input') args.input = rest.shift();
    else if (flag === '--output') args.output = rest.shift();
    else if (flag === '--state') args.state = rest.shift();
    else throw new LedgerError('USAGE', `unknown argument: ${flag}`);
  }
  if (!args.command) {
    throw new LedgerError(
      'USAGE',
      'usage: settle.js <create|correct|confirm|revoke|status|certificate|audit> --input in.json [--output out.json] [--state state.jsonl]',
    );
  }
  return args;
}

function readPayload(path) {
  if (!path) {
    throw new LedgerError('USAGE', '--input <file.json> is required');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LedgerError('INVALID_INPUT', `cannot read input JSON: ${error.message}`);
  }
}

export function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: error.code ?? 'USAGE', message: error.message } })}\n`,
    );
    return 1;
  }
  try {
    const ledger = Ledger.replay(loadEvents(args.state));
    let result;
    if (MUTATING[args.command]) {
      const payload = readPayload(args.input);
      const before = ledger.events.length;
      result = ledger[MUTATING[args.command]](payload);
      for (const event of ledger.events.slice(before)) {
        appendEvent(args.state, event);
      }
    } else if (args.command === 'status') {
      result = ledger.getBatch(readPayload(args.input).batchId);
    } else if (args.command === 'certificate') {
      result = ledger.getCertificate(readPayload(args.input).batchId);
    } else if (args.command === 'audit') {
      result = ledger.auditTrail(readPayload(args.input).batchId);
    } else {
      throw new LedgerError('USAGE', `unknown command: ${args.command}`);
    }
    const text = `${JSON.stringify({ ok: true, result }, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, text, 'utf8');
    io.stdout.write(text);
    return 0;
  } catch (error) {
    const code = error instanceof LedgerError ? error.code : 'INTERNAL_ERROR';
    const text = `${JSON.stringify({ ok: false, error: { code, message: error.message } })}\n`;
    if (args.output) {
      try {
        writeFileSync(args.output, text, 'utf8');
      } catch {
        // ignore secondary write failure
      }
    }
    io.stderr.write(text);
    return 1;
  }
}
