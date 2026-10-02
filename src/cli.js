#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store, stateToJson } from './store.js';

const USAGE = `walstore - auditable WAL-based measurement storage

Usage: walstore [--data DIR] <command> [options]

Commands:
  apply --device D --key K (--value V | --del) [--crash-after write|fsync]
      Append one logical change (its own transaction) to the WAL.
  replay [--to SEQ]
      Rebuild and print the full state at transaction SEQ (default: latest).
  audit
      Compare the persisted secondary index against a full WAL replay.
  checkpoint
      Write a checkpoint of the current state.
  inject (--truncate-at BYTES | --corrupt-index)
      Fault injection: truncate the WAL at a byte offset (crash simulation)
      or corrupt the secondary index (for audit verification).

Error codes: NO_SUCH_TXN, CHECKSUM_MISMATCH, LOG_GAP, USAGE.
`;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function main(argv, { exit, out, err }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: 'string', default: process.env.WALSTORE_DATA ?? 'data' },
      device: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      del: { type: 'boolean', default: false },
      to: { type: 'string' },
      'crash-after': { type: 'string' },
      'truncate-at': { type: 'string' },
      'corrupt-index': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command] = positionals;
  if (values.help || !command) {
    out(USAGE);
    return 0;
  }

  const dir = values.data;

  switch (command) {
    case 'apply': {
      if (!values.device || !values.key) fail('USAGE', 'apply requires --device and --key');
      if (!values.del && values.value === undefined) fail('USAGE', 'apply requires --value or --del');
      const crashAfter = values['crash-after'];
      if (crashAfter && !['write', 'fsync'].includes(crashAfter)) {
        fail('USAGE', '--crash-after must be write or fsync');
      }
      const crash = () => {
        err(`CRASH simulated after ${crashAfter}`);
        exit(2);
      };
      const hooks = crashAfter
        ? { onAfterWrite: crashAfter === 'write' ? crash : undefined, onAfterFsync: crashAfter === 'fsync' ? crash : undefined }
        : {};
      const store = new Store(dir).open();
      const record = store.apply(
        { device: values.device, key: values.key, value: parseValue(values.value ?? 'null'), del: values.del },
        hooks,
      );
      store.close();
      out(JSON.stringify(record));
      return 0;
    }

    case 'replay': {
      const store = new Store(dir).open();
      const to = values.to === undefined ? undefined : Number(values.to);
      const { seq, state } = store.replay(to);
      store.close();
      out(JSON.stringify({ seq, state: stateToJson(state) }));
      return 0;
    }

    case 'audit': {
      const store = new Store(dir).open();
      const divergences = store.audit();
      store.close();
      if (divergences.length === 0) {
        out('OK: index matches WAL replay');
        return 0;
      }
      out(`DIVERGENCE: ${divergences.length} ${divergences.length === 1 ? 'entry differs' : 'entries differ'}`);
      for (const d of divergences) {
        out(`  ${d.kind}: device=${d.device} key=${d.key}`);
      }
      return 1;
    }

    case 'checkpoint': {
      const store = new Store(dir).open();
      const checkpoint = store.checkpoint();
      store.close();
      out(JSON.stringify({ seq: checkpoint.seq }));
      return 0;
    }

    case 'inject': {
      const walPath = path.join(dir, 'wal.log');
      const indexPath = path.join(dir, 'index.json');
      if (values['truncate-at'] !== undefined) {
        const offset = Number(values['truncate-at']);
        if (!Number.isInteger(offset) || offset < 0) fail('USAGE', '--truncate-at must be a non-negative integer');
        const size = fs.statSync(walPath).size;
        if (offset > size) fail('USAGE', `--truncate-at ${offset} beyond wal size ${size}`);
        fs.truncateSync(walPath, offset);
        out(`truncated wal.log from ${size} to ${offset} bytes`);
        return 0;
      }
      if (values['corrupt-index']) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        index.devices ??= {};
        const device = Object.keys(index.devices)[0] ?? 'phantom-device';
        index.devices[device] = [...(index.devices[device] ?? []), 'phantom-key'];
        fs.writeFileSync(indexPath, JSON.stringify(index));
        out(`corrupted index.json: added phantom key under device ${device}`);
        return 0;
      }
      fail('USAGE', 'inject requires --truncate-at BYTES or --corrupt-index');
      break;
    }

    default:
      fail('USAGE', `unknown command: ${command}`);
  }
  return 0;
}

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

// Run the CLI in-process, capturing output and the exit code. Used by the
// real entry point and by tests (crash simulation included: the injected
// exit unwinds abruptly, exactly like the process dying).
export function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const out = (line) => { stdout += `${line}\n`; };
  const err = (line) => { stderr += `${line}\n`; };
  try {
    const code = main(argv, {
      exit: (code) => { throw new ExitSignal(code); },
      out,
      err,
    });
    return { code: code ?? 0, stdout, stderr };
  } catch (error) {
    if (error instanceof ExitSignal) {
      return { code: error.exitCode, stdout, stderr };
    }
    err(`ERROR ${error.code ?? 'INTERNAL'}: ${error.message}`);
    return { code: 1, stdout, stderr };
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
